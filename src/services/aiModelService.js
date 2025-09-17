const { SageMakerRuntimeClient, InvokeEndpointCommand } = require('@aws-sdk/client-sagemaker-runtime');
const axios = require('axios');
const winston = require('winston');

const s3Service = require('./s3Service');
const supabaseService = require('./supabaseService');

// Configure logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'ai-model-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Initialize SageMaker client
const sageMakerClient = new SageMakerRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

class AIModelService {
  constructor() {
    this.endpointName = process.env.SAGEMAKER_ENDPOINT_NAME || 'event-ai-model-endpoint';
    this.modelApiUrl = process.env.AI_MODEL_API_URL;
    this.runningSimulations = new Map(); // Track running simulations
  }

  /**
   * Runs AI simulation for an event
   * @param {string} simulationId - Simulation ID
   * @param {string} eventId - Event ID
   * @param {Object} parameters - Simulation parameters
   * @returns {Promise<Object>} - Simulation results
   */
  async runSimulation(simulationId, eventId, parameters = {}) {
    try {
      logger.info('Starting AI simulation', { simulationId, eventId, parameters });

      // Track this simulation as running
      this.runningSimulations.set(simulationId, {
        startTime: Date.now(),
        eventId,
        parameters
      });

      // Get event data from RDS
      const event = await supabaseService.getEventById(eventId);
      if (!event) {
        throw new Error('Event not found');
      }

      // Prepare simulation input data
      const simulationInput = await this.prepareSimulationInput(event, parameters);

      // Update progress to 10%
      await supabaseService.updateSimulationProgress(simulationId, {
        percentage: 10,
        stage: 'data_preparation',
        message: 'Simulation data prepared'
      });

      let results;
      
      // Try SageMaker endpoint first, fallback to custom API
      if (this.endpointName && process.env.USE_SAGEMAKER !== 'false') {
        results = await this.runSageMakerSimulation(simulationInput, simulationId);
      } else if (this.modelApiUrl) {
        results = await this.runCustomApiSimulation(simulationInput, simulationId);
      } else {
        // Fallback to mock simulation for development
        results = await this.runMockSimulation(simulationInput, simulationId);
      }

      // Remove from running simulations
      this.runningSimulations.delete(simulationId);

      logger.info('AI simulation completed successfully', { simulationId, duration: Date.now() - this.runningSimulations.get(simulationId)?.startTime });

      return results;
    } catch (error) {
      // Remove from running simulations on error
      this.runningSimulations.delete(simulationId);
      
      logger.error('Error running AI simulation', { simulationId, eventId, error: error.message });
      throw new Error(`AI simulation failed: ${error.message}`);
    }
  }

  /**
   * Prepares input data for AI simulation
   * @param {Object} event - Event data
   * @param {Object} parameters - Simulation parameters
   * @returns {Promise<Object>} - Prepared simulation input
   */
  async prepareSimulationInput(event, parameters) {
    try {
      logger.info('Preparing simulation input data', { eventId: event.eventId });

      const simulationInput = {
        eventId: event.eventId,
        eventDetails: {
          name: event.name,
          venue: event.venue,
          expectedAttendees: event.expectedAttendees,
          eventDate: event.eventDate,
          eventType: event.eventType
        },
        parameters: {
          crowdDensityThreshold: parameters.crowdDensityThreshold || 0.7,
          simulationDuration: parameters.simulationDuration || 3600, // 1 hour default
          weatherConditions: parameters.weatherConditions || 'sunny',
          emergencyScenarios: parameters.emergencyScenarios || [],
          ...parameters
        },
        timestamp: new Date().toISOString()
      };

      // Add ticketing data if available
      if (event.s3Keys?.ticketingData) {
        try {
          simulationInput.ticketingData = await s3Service.getJson(event.s3Keys.ticketingData);
        } catch (error) {
          logger.warn('Could not retrieve ticketing data', { eventId: event.eventId, error: error.message });
        }
      }

      // Add seating chart if available
      if (event.s3Keys?.seatingChart) {
        try {
          simulationInput.seatingChart = await s3Service.getJson(event.s3Keys.seatingChart);
        } catch (error) {
          logger.warn('Could not retrieve seating chart', { eventId: event.eventId, error: error.message });
        }
      }

      logger.info('Simulation input data prepared successfully', { eventId: event.eventId });
      return simulationInput;
    } catch (error) {
      logger.error('Error preparing simulation input', { eventId: event.eventId, error: error.message });
      throw error;
    }
  }

  /**
   * Runs simulation using SageMaker endpoint
   * @param {Object} inputData - Simulation input data
   * @param {string} simulationId - Simulation ID
   * @returns {Promise<Object>} - Simulation results
   */
  async runSageMakerSimulation(inputData, simulationId) {
    try {
      logger.info('Running SageMaker simulation', { simulationId, endpointName: this.endpointName });

      // Update progress
      await supabaseService.updateSimulationProgress(simulationId, {
        percentage: 25,
        stage: 'model_inference',
        message: 'Starting AI model inference'
      });

      const command = new InvokeEndpointCommand({
        EndpointName: this.endpointName,
        ContentType: 'application/json',
        Body: JSON.stringify(inputData)
      });

      const response = await sageMakerClient.send(command);
      const results = JSON.parse(Buffer.from(response.Body).toString());

      // Update progress
      await supabaseService.updateSimulationProgress(simulationId, {
        percentage: 90,
        stage: 'processing_results',
        message: 'Processing simulation results'
      });

      logger.info('SageMaker simulation completed', { simulationId });
      return this.processSimulationResults(results);
    } catch (error) {
      logger.error('Error running SageMaker simulation', { simulationId, error: error.message });
      throw error;
    }
  }

  /**
   * Runs simulation using custom API endpoint
   * @param {Object} inputData - Simulation input data
   * @param {string} simulationId - Simulation ID
   * @returns {Promise<Object>} - Simulation results
   */
  async runCustomApiSimulation(inputData, simulationId) {
    try {
      logger.info('Running custom API simulation', { simulationId, apiUrl: this.modelApiUrl });

      // Update progress
      await supabaseService.updateSimulationProgress(simulationId, {
        percentage: 25,
        stage: 'api_call',
        message: 'Calling AI model API'
      });

      const response = await axios.post(this.modelApiUrl, inputData, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': process.env.AI_MODEL_API_KEY ? `Bearer ${process.env.AI_MODEL_API_KEY}` : undefined
        },
        timeout: 300000 // 5 minutes timeout
      });

      // Update progress
      await supabaseService.updateSimulationProgress(simulationId, {
        percentage: 90,
        stage: 'processing_results',
        message: 'Processing simulation results'
      });

      logger.info('Custom API simulation completed', { simulationId });
      return this.processSimulationResults(response.data);
    } catch (error) {
      logger.error('Error running custom API simulation', { simulationId, error: error.message });
      throw error;
    }
  }

  /**
   * Runs mock simulation for development/testing
   * @param {Object} inputData - Simulation input data
   * @param {string} simulationId - Simulation ID
   * @returns {Promise<Object>} - Mock simulation results
   */
  async runMockSimulation(inputData, simulationId) {
    try {
      logger.info('Running mock simulation', { simulationId });

      // Simulate processing time with progress updates
      const progressSteps = [
        { percentage: 25, stage: 'crowd_analysis', message: 'Analyzing crowd patterns' },
        { percentage: 50, stage: 'hotspot_detection', message: 'Detecting congestion hotspots' },
        { percentage: 75, stage: 'recommendation_generation', message: 'Generating recommendations' },
        { percentage: 90, stage: 'result_compilation', message: 'Compiling results' }
      ];

      for (const step of progressSteps) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        await supabaseService.updateSimulationProgress(simulationId, step);
      }

      // Generate mock results based on input data
      const mockResults = {
        simulationId,
        eventId: inputData.eventId,
        completedAt: new Date().toISOString(),
        crowdAnalysis: {
          totalAttendees: inputData.eventDetails.expectedAttendees,
          peakCrowdTime: '20:30',
          averageDensity: 0.65,
          maxDensity: 0.85
        },
        hotspots: [
          {
            id: 'hotspot_1',
            location: 'Main Entrance',
            severity: 'HIGH',
            density: 0.92,
            estimatedWaitTime: 15,
            coordinates: { x: 100, y: 50 }
          },
          {
            id: 'hotspot_2',
            location: 'Food Court',
            severity: 'MEDIUM',
            density: 0.78,
            estimatedWaitTime: 8,
            coordinates: { x: 200, y: 150 }
          },
          {
            id: 'hotspot_3',
            location: 'Restrooms - Section A',
            severity: 'HIGH',
            density: 0.88,
            estimatedWaitTime: 12,
            coordinates: { x: 150, y: 100 }
          }
        ],
        recommendations: [
          {
            id: 'rec_1',
            type: 'CROWD_CONTROL',
            priority: 'HIGH',
            title: 'Deploy Additional Staff at Main Entrance',
            description: 'High congestion detected at main entrance. Deploy 3 additional staff members to manage crowd flow.',
            estimatedImpact: 'Reduce wait time by 60%',
            implementationTime: '10 minutes'
          },
          {
            id: 'rec_2',
            type: 'FACILITY_MANAGEMENT',
            priority: 'MEDIUM',
            title: 'Open Additional Food Vendors',
            description: 'Open 2 additional food vendors to distribute crowd load in food court area.',
            estimatedImpact: 'Reduce density by 25%',
            implementationTime: '15 minutes'
          }
        ],
        chartData: {
          crowdFlowOverTime: this.generateMockChartData('crowdFlow', 24),
          densityHeatmap: this.generateMockHeatmapData(),
          waitTimeAnalysis: this.generateMockChartData('waitTime', 24)
        },
        metadata: {
          simulationDuration: inputData.parameters.simulationDuration,
          weatherConditions: inputData.parameters.weatherConditions,
          emergencyScenarios: inputData.parameters.emergencyScenarios,
          processingTime: '45 seconds',
          dataPoints: 15420
        }
      };

      logger.info('Mock simulation completed', { simulationId });
      return mockResults;
    } catch (error) {
      logger.error('Error running mock simulation', { simulationId, error: error.message });
      throw error;
    }
  }

  /**
   * Processes and standardizes simulation results
   * @param {Object} rawResults - Raw results from AI model
   * @returns {Object} - Processed results
   */
  processSimulationResults(rawResults) {
    try {
      // Ensure results have required structure
      const processedResults = {
        ...rawResults,
        processedAt: new Date().toISOString(),
        version: '1.0'
      };

      // Validate required fields
      if (!processedResults.hotspots) {
        processedResults.hotspots = [];
      }
      if (!processedResults.recommendations) {
        processedResults.recommendations = [];
      }
      if (!processedResults.crowdAnalysis) {
        processedResults.crowdAnalysis = {};
      }

      return processedResults;
    } catch (error) {
      logger.error('Error processing simulation results', { error: error.message });
      throw error;
    }
  }

  /**
   * Cancels a running simulation
   * @param {string} simulationId - Simulation ID
   * @returns {Promise<boolean>} - True if cancelled successfully
   */
  async cancelSimulation(simulationId) {
    try {
      logger.info('Cancelling simulation', { simulationId });

      const runningSimulation = this.runningSimulations.get(simulationId);
      if (!runningSimulation) {
        logger.warn('Simulation not found in running simulations', { simulationId });
        return false;
      }

      // Remove from running simulations
      this.runningSimulations.delete(simulationId);

      logger.info('Simulation cancelled successfully', { simulationId });
      return true;
    } catch (error) {
      logger.error('Error cancelling simulation', { simulationId, error: error.message });
      throw error;
    }
  }

  /**
   * Gets status of all running simulations
   * @returns {Array} - Array of running simulation statuses
   */
  getRunningSimulations() {
    const runningList = [];
    for (const [simulationId, data] of this.runningSimulations.entries()) {
      runningList.push({
        simulationId,
        eventId: data.eventId,
        startTime: data.startTime,
        duration: Date.now() - data.startTime,
        parameters: data.parameters
      });
    }
    return runningList;
  }

  /**
   * Generates mock chart data for development
   * @param {string} type - Chart type
   * @param {number} points - Number of data points
   * @returns {Array} - Chart data
   */
  generateMockChartData(type, points) {
    const data = [];
    for (let i = 0; i < points; i++) {
      const timestamp = new Date(Date.now() - (points - i) * 3600000).toISOString();
      let value;
      
      switch (type) {
        case 'crowdFlow':
          value = Math.floor(Math.random() * 1000) + 500;
          break;
        case 'waitTime':
          value = Math.floor(Math.random() * 20) + 2;
          break;
        default:
          value = Math.random();
      }
      
      data.push({ timestamp, value });
    }
    return data;
  }

  /**
   * Generates mock heatmap data for development
   * @returns {Array} - Heatmap data
   */
  generateMockHeatmapData() {
    const heatmapData = [];
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) {
        heatmapData.push({
          x,
          y,
          intensity: Math.random()
        });
      }
    }
    return heatmapData;
  }
}

module.exports = new AIModelService();

