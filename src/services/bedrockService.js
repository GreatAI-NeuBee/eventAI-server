const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const winston = require('winston');
const { generateRecommendationPrompt } = require("../utils/promptGenerator");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'bedrock-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class BedrockService {
  constructor() {
    // Use ap-southeast-5 region if available, since user has access there
    const region = 'us-east-1';

    this.client = new BedrockRuntimeClient({
      region: region,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });

    // AWS Bedrock Nova Lite configuration
    // MUST use inference profile ARN - modelId is not supported in this region
    this.inferenceProfileArn = process.env.BEDROCK_INFERENCE_PROFILE_ARN;

    if (!this.inferenceProfileArn) {
      logger.error('BEDROCK_INFERENCE_PROFILE_ARN is required but not set in environment variables');
      throw new Error('BEDROCK_INFERENCE_PROFILE_ARN environment variable is required for Bedrock access');
    }

    logger.info('BedrockService initialized', {
      region: region,
      inferenceProfileArn: this.inferenceProfileArn
    });
  }

  /**
   * Analyzes event popularity using AWS Bedrock Nova Lite model
   * @param {Object} popularityData - Event popularity information
   * @param {string} popularityData.type - Event type (concert or event)
   * @param {string} popularityData.feat - Featured artists or personalities
   * @param {string} popularityData.location - Event location
   * @returns {Promise<Object>} - AI-analyzed popularity insights
   */
  async analyzeEventPopularity(popularityData) {
    try {
      const { type, feat, location } = popularityData;

      logger.info('Analyzing event popularity with Bedrock', {
        type,
        feat,
        location
      });

      // Construct the prompt for Nova Lite
      const prompt = `You are an event operations and safety analyst. Analyze the following event information and provide practical operational insights for crowd management and safety.

Event Details:
- Type: ${type}
- Featured: ${feat}
- Location: ${location}

Please provide a comprehensive operational analysis in JSON format with the following structure:
{
  "popularityScore": <number 0-100 indicating overall popularity level>,
  "popularityLevel": <string: "Very High", "High", "Medium", "Low" based on the score>,
  "expectedTurnout": {
    "minimum": <number of expected attendees - minimum estimate>,
    "expected": <number of expected attendees - most likely>,
    "maximum": <number of expected attendees - maximum estimate>
  },
  "audienceDemographics": {
    "ageGroups": {
      "children": <percentage 0-100>,
      "teens": <percentage 0-100>,
      "youngAdults": <percentage 0-100>,
      "middleAged": <percentage 0-100>,
      "seniors": <percentage 0-100>
    },
    "primaryAgeRange": <string like "25-45 years old">,
    "mobilityConsiderations": <string describing if audience includes elderly, disabled, or requires special assistance>,
    "behaviorProfile": <string describing expected audience behavior - calm, energetic, rushing, etc.>
  },
  "crowdFlowAnalysis": {
    "entrySpeed": <string: "Fast", "Moderate", "Slow" - based on demographics>,
    "entrySpeedRationale": <string explaining why entry will be at this speed>,
    "peakCongestionTimes": [<array of strings like "30 minutes before start", "immediately after event ends">],
    "bottleneckAreas": [<array of potential bottleneck locations like "Main entrance", "Parking area", "Merchandise booths">]
  },
  "historicalIncidents": [
    {
      "incident": <string describing a past incident at similar events>,
      "date": <string if known, or "Unknown">,
      "casualties": <string describing impact>,
      "cause": <string describing root cause>
    }
  ],
  "riskAssessment": {
    "highRisks": [<array of high-priority safety risks for this specific event type and artist>],
    "mediumRisks": [<array of moderate risks>],
    "weatherRelatedRisks": [<array of weather-related concerns for the location>]
  },
  "operationalRecommendations": {
    "staffingRequirements": {
      "securityPersonnel": <number of recommended security staff>,
      "medicalStaff": <number of recommended medical personnel>,
      "crowdControlOfficers": <number of crowd control staff>,
      "assistanceStaff": <number of staff to help elderly/disabled>,
      "rationale": <string explaining the staffing numbers>
    },
    "entranceManagement": [
      <array of specific recommendations for managing entry, like "Open gates 2 hours early for elderly ticket holders", "Use separate lanes for VIP and general admission">
    ],
    "crowdControl": [
      <array of crowd control measures like "Install barriers in Queue areas", "Deploy staff at choke points">
    ],
    "emergencyPreparedness": [
      <array of emergency preparedness steps like "Establish clear evacuation routes", "Station ambulances at exits">
    ],
    "specialConsiderations": [
      <array of special considerations based on the demographics>
    ]
  },
  "safetyMeasures": {
    "mandatory": [<array of must-have safety measures>],
    "recommended": [<array of recommended safety enhancements>],
    "equipmentNeeded": [<array of equipment like "Wheelchairs", "First aid kits", "Crowd barriers">]
  }
}

Focus on practical, actionable operational insights. Base your analysis on known incidents and risks associated with similar events. Consider the specific characteristics of the featured artist/personality and their fan base. Provide ONLY the JSON response, no additional text.`;

      // Prepare the request payload for Nova Lite
      const payload = {
        messages: [
          {
            role: 'user',
            content: [
              {
                text: prompt
              }
            ]
          }
        ],
        inferenceConfig: {
          max_new_tokens: 2000,
          temperature: 0.7,
          top_p: 0.9
        }
      };

      // Invoke the Nova Lite model using inference profile ARN as modelId
      // Important: The inferenceProfileArn goes into the modelId field
      const command = new InvokeModelCommand({
        modelId: "amazon.nova-lite-v1:0",
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload)
      });

      logger.info('Invoking Bedrock Nova Lite model', {
        modelId: this.inferenceProfileArn
      });

      const response = await this.client.send(command);

      // Parse the response
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      logger.info('Bedrock response received', {
        stopReason: responseBody.stopReason,
        outputTokens: responseBody.usage?.outputTokens
      });

      // Extract the content from Nova Lite response
      const content = responseBody.output?.message?.content?.[0]?.text || responseBody.content?.[0]?.text;

      if (!content) {
        throw new Error('No content in Bedrock response');
      }

      // Parse the JSON response from the model
      let analysisResult;
      try {
        // Try to extract JSON from the response (in case there's extra text)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          analysisResult = JSON.parse(jsonMatch[0]);
        } else {
          analysisResult = JSON.parse(content);
        }
      } catch (parseError) {
        logger.error('Failed to parse Bedrock JSON response', {
          error: parseError.message,
          content: content.substring(0, 200)
        });

        // Fallback: return a basic analysis if JSON parsing fails
        analysisResult = {
          popularityScore: 50,
          popularityLevel: "Medium",
          expectedTurnout: {
            minimum: 0,
            expected: 0,
            maximum: 0
          },
          audienceDemographics: {
            ageGroups: {
              children: 0,
              teens: 0,
              youngAdults: 0,
              middleAged: 0,
              seniors: 0
            },
            primaryAgeRange: "Unknown",
            mobilityConsiderations: "Unable to analyze automatically",
            behaviorProfile: "Please review manually"
          },
          crowdFlowAnalysis: {
            entrySpeed: "Unknown",
            entrySpeedRationale: "Automated analysis failed",
            peakCongestionTimes: ["Requires manual analysis"],
            bottleneckAreas: ["Requires manual analysis"]
          },
          historicalIncidents: [],
          riskAssessment: {
            highRisks: ["Automated analysis unavailable - manual review required"],
            mediumRisks: [],
            weatherRelatedRisks: []
          },
          operationalRecommendations: {
            staffingRequirements: {
              securityPersonnel: 0,
              medicalStaff: 0,
              crowdControlOfficers: 0,
              assistanceStaff: 0,
              rationale: "Automated analysis failed - please conduct manual assessment"
            },
            entranceManagement: ["Review event details manually"],
            crowdControl: ["Conduct on-site assessment"],
            emergencyPreparedness: ["Develop emergency plan based on venue capacity"],
            specialConsiderations: ["Manual review required"]
          },
          safetyMeasures: {
            mandatory: ["Follow local safety regulations"],
            recommended: ["Conduct safety audit"],
            equipmentNeeded: ["To be determined based on venue assessment"]
          },
          rawResponse: content
        };
      }

      // Add metadata
      analysisResult.metadata = {
        analyzedAt: new Date().toISOString(),
        modelId: this.modelId,
        modelVersion: 'nova-lite-v1',
        inputData: popularityData
      };

      logger.info('Event popularity analysis completed successfully', {
        popularityScore: analysisResult.popularityScore
      });

      return analysisResult;

    } catch (error) {
      logger.error('Error analyzing event popularity', {
        error: error.message,
        errorCode: error.name,
        popularityData
      });

      // Return a fallback response instead of throwing
      return {
        error: true,
        errorMessage: error.message,
        popularityScore: 0,
        popularityLevel: "Unknown",
        expectedTurnout: {
          minimum: 0,
          expected: 0,
          maximum: 0
        },
        audienceDemographics: {
          ageGroups: {
            children: 0,
            teens: 0,
            youngAdults: 0,
            middleAged: 0,
            seniors: 0
          },
          primaryAgeRange: "Analysis failed",
          mobilityConsiderations: "Unable to determine",
          behaviorProfile: "Analysis error occurred"
        },
        crowdFlowAnalysis: {
          entrySpeed: "Unknown",
          entrySpeedRationale: "Analysis failed",
          peakCongestionTimes: ["Unable to analyze"],
          bottleneckAreas: ["Unable to analyze"]
        },
        historicalIncidents: [],
        riskAssessment: {
          highRisks: ["Automated analysis unavailable", error.message],
          mediumRisks: [],
          weatherRelatedRisks: []
        },
        operationalRecommendations: {
          staffingRequirements: {
            securityPersonnel: 0,
            medicalStaff: 0,
            crowdControlOfficers: 0,
            assistanceStaff: 0,
            rationale: "Analysis error - manual review required"
          },
          entranceManagement: ["Manual review required due to analysis error"],
          crowdControl: ["Retry the analysis later"],
          emergencyPreparedness: ["Conduct manual safety assessment"],
          specialConsiderations: ["Analysis failed - manual planning required"]
        },
        safetyMeasures: {
          mandatory: ["Follow local safety regulations"],
          recommended: ["Conduct manual risk assessment"],
          equipmentNeeded: ["To be determined manually"]
        },
        metadata: {
          analyzedAt: new Date().toISOString(),
          error: error.message
        }
      };
    }
  }

  async getIncidentRecommendation(forecastResult, forecastData) {
    const modelId = "amazon.nova-lite-v1:0";
    const prompt = generateRecommendationPrompt(forecastResult, forecastData);

    const input = {
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [{ text: prompt }],
          }
        ],
        inferenceConfig: {
          temperature: 0.7,
          topP: 0.9,
          // maxOutputTokens: 400
        }
      })
    };

    try {
      const command = new InvokeModelCommand(input);
      const response = await this.client.send(command);

      const decoded = new TextDecoder().decode(response.body);
      const parsed = JSON.parse(decoded);

      // Extract AI output text
      let recommendationJSON;
      try {
        let outputText = parsed.output?.message?.content?.[0]?.text || "{}";

        // Remove markdown code fences if present
        outputText = outputText.replace(/^```json\s*|\s*```$/g, "").trim();

        recommendationJSON = JSON.parse(outputText);

        // Ensure always has gates & generalRecommendations
        recommendationJSON.gates = recommendationJSON.gates || [];
        recommendationJSON.generalRecommendations = recommendationJSON.generalRecommendations || [];
      } catch (jsonErr) {
        console.warn("AI returned invalid JSON, returning fallback structure", jsonErr);
        recommendationJSON = {
          gates: [],
          generalRecommendations: ["AI response invalid, no recommendations available"],
          rawText: parsed
        };
      }


      return recommendationJSON;

    } catch (err) {
      console.error("Error calling Bedrock AI for incident recommendation", err);
      return { error: "Failed to get AI recommendations", details: err.message };
    }
  }

  /**
   * Validates popularity data structure
   * @param {Object} popularityData - Popularity data to validate
   * @returns {Object} - Validation result
   */
  validatePopularityData(popularityData) {
    const errors = [];

    if (!popularityData || typeof popularityData !== 'object') {
      errors.push('Popularity data must be an object');
      return { valid: false, errors };
    }

    // Validate type
    if (!popularityData.type) {
      errors.push('Type is required');
    } else if (!['concert', 'event'].includes(popularityData.type.toLowerCase())) {
      errors.push('Type must be either "concert" or "event"');
    }

    // Validate feat
    if (!popularityData.feat) {
      errors.push('Featured artists/personalities (feat) is required');
    } else if (typeof popularityData.feat !== 'string' || popularityData.feat.trim().length === 0) {
      errors.push('Featured artists/personalities must be a non-empty string');
    }

    // Validate location
    if (!popularityData.location) {
      errors.push('Location is required');
    } else if (typeof popularityData.location !== 'string' || popularityData.location.trim().length === 0) {
      errors.push('Location must be a non-empty string');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Checks the health of the Bedrock service
   * @returns {Promise<Object>} - Health status
   */
  async checkHealth() {
    try {
      // Simple test to check if credentials are valid
      const testPayload = {
        messages: [
          {
            role: 'user',
            content: [{ text: 'Test' }]
          }
        ],
        inferenceConfig: {
          max_new_tokens: 10,
          temperature: 0.1
        }
      };

      const command = new InvokeModelCommand({
        modelId: this.inferenceProfileArn,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(testPayload)
      });

      await this.client.send(command);

      return {
        healthy: true,
        service: 'AWS Bedrock Nova Lite',
        inferenceProfileArn: this.inferenceProfileArn,
        region: process.env.AWS_REGION || 'ap-southeast-5',
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.warn('Bedrock health check failed', { error: error.message });
      return {
        healthy: false,
        service: 'AWS Bedrock Nova Lite',
        inferenceProfileArn: this.inferenceProfileArn,
        error: error.message,
        checkedAt: new Date().toISOString()
      };
    }
  }
}

module.exports = new BedrockService();
