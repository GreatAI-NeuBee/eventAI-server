const PDFDocument = require('pdfkit');
const { Readable } = require('stream');
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'report-service' },
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

class ReportService {
  /**
   * Pre-processes event data for report generation
   * Analyzes forecast data and extracts key insights
   * @param {Object} event - Event data with forecast_result
   * @returns {Object} - Processed data with insights
   */
  preprocessEventData(event) {
    const processed = {
      event: event,
      gates: [],
      overallInsights: {
        totalExpectedAttendees: 0,
        criticalPeriods: [],
        highRiskGates: [],
        requiredResources: {
          security: 0,
          medical: 0,
          staff: 0
        }
      }
    };

    if (!event.forecastResult || !event.forecastResult.forecast) {
      return processed;
    }

    const forecast = event.forecastResult.forecast;
    const gates = Object.keys(forecast);

    gates.forEach(gateName => {
      const gateData = forecast[gateName];
      const timeFrames = gateData.timeFrames || [];
      const capacity = gateData.capacity || 0;

      // Find peak hour
      let peakTimeFrame = timeFrames[0] || {};
      let peakCount = 0;
      let peakTime = 'N/A';

      timeFrames.forEach(tf => {
        const count = Math.abs(tf.predicted || tf.yhat || 0);
        if (count > peakCount) {
          peakCount = count;
          peakTime = tf.timestamp || tf.time || 'N/A';
          peakTimeFrame = tf;
        }
      });

      // Calculate average crowd
      const avgCrowd = timeFrames.length > 0
        ? timeFrames.reduce((sum, tf) => sum + Math.abs(tf.predicted || tf.yhat || 0), 0) / timeFrames.length
        : 0;

      // Find critical periods (>80% capacity)
      const criticalPeriods = timeFrames
        .filter(tf => Math.abs(tf.predicted || tf.yhat || 0) >= capacity * 0.8)
        .map(tf => ({
          time: tf.timestamp || tf.time,
          count: Math.round(Math.abs(tf.predicted || tf.yhat || 0)),
          percentage: ((Math.abs(tf.predicted || tf.yhat || 0) / capacity) * 100).toFixed(1)
        }));

      // Find high occupancy periods (>50% capacity)
      const highOccupancyPeriods = timeFrames
        .filter(tf => {
          const count = Math.abs(tf.predicted || tf.yhat || 0);
          return count >= capacity * 0.5 && count < capacity * 0.8;
        })
        .map(tf => ({
          time: tf.timestamp || tf.time,
          count: Math.round(Math.abs(tf.predicted || tf.yhat || 0)),
          percentage: ((Math.abs(tf.predicted || tf.yhat || 0) / capacity) * 100).toFixed(1)
        }));

      // Generate time series for graph (sample every 30 minutes)
      const timeSeriesData = [];
      
      // Log first few timeframes to understand structure
      logger.info('TimeFrames structure check', {
        gate: gateName,
        totalCount: timeFrames.length,
        firstThree: timeFrames.slice(0, 3),
        sample: timeFrames[0]
      });
      
      // Sample every 6 timeframes (30 min if 5-min intervals)
      for (let i = 0; i < timeFrames.length; i += 6) {
        const tf = timeFrames[i];
        if (tf) {
          // Get time field
          const time = tf.timestamp || tf.time || tf.datetime || `Frame ${i}`;
          
          // Get count - use absolute value as negative values indicate different flow direction
          const rawCount = tf.predicted || tf.yhat || tf.count || 0;
          const count = Math.round(Math.abs(rawCount));
          
          // Calculate percentage
          const pct = capacity > 0 ? ((count / capacity) * 100).toFixed(0) : 0;
          
          timeSeriesData.push({
            time: time,
            count: count,
            percentage: pct
          });
        }
      }

      logger.info('Generated time series data', {
        gate: gateName,
        timeFramesCount: timeFrames.length,
        timeSeriesCount: timeSeriesData.length,
        sampleData: timeSeriesData.slice(0, 3)
      });

      // Risk assessment
      const peakUtilization = capacity > 0 ? (peakCount / capacity) * 100 : 0;
      let riskLevel = 'Low';
      let riskColor = '#10b981';
      
      if (peakUtilization >= 90) {
        riskLevel = 'Critical';
        riskColor = '#ef4444';
      } else if (peakUtilization >= 70) {
        riskLevel = 'High';
        riskColor = '#f59e0b';
      } else if (peakUtilization >= 50) {
        riskLevel = 'Moderate';
        riskColor = '#3b82f6';
      }

      // Recommendations based on risk
      const recommendations = this.generateGateRecommendations(
        gateName, 
        capacity, 
        peakCount, 
        criticalPeriods.length,
        riskLevel
      );

      processed.gates.push({
        name: gateName,
        capacity: capacity,
        peak: {
          time: peakTime,
          count: Math.round(peakCount),
          utilization: peakUtilization.toFixed(1)
        },
        average: Math.round(avgCrowd),
        criticalPeriods: criticalPeriods,
        highOccupancyPeriods: highOccupancyPeriods,
        timeSeriesData: timeSeriesData,
        riskLevel: riskLevel,
        riskColor: riskColor,
        recommendations: recommendations,
        totalTimeFrames: timeFrames.length
      });

      // Update overall insights
      processed.overallInsights.totalExpectedAttendees += Math.round(peakCount);
      
      if (riskLevel === 'Critical' || riskLevel === 'High') {
        processed.overallInsights.highRiskGates.push({
          gate: gateName,
          riskLevel: riskLevel,
          peakTime: peakTime,
          peakCount: Math.round(peakCount)
        });
      }

      if (criticalPeriods.length > 0) {
        processed.overallInsights.criticalPeriods.push({
          gate: gateName,
          periods: criticalPeriods
        });
      }
    });

    // Calculate required resources
    processed.overallInsights.requiredResources = this.calculateRequiredResources(
      processed.gates,
      processed.overallInsights.totalExpectedAttendees
    );

    return processed;
  }

  /**
   * Generates gate-specific recommendations
   */
  generateGateRecommendations(gateName, capacity, peakCount, criticalPeriodCount, riskLevel) {
    const recommendations = [];
    const ratio = capacity > 0 ? peakCount / capacity : 0;

    if (riskLevel === 'Critical') {
      recommendations.push(`Deploy additional security personnel at Gate ${gateName} during peak hours`);
      recommendations.push(`Install crowd control barriers to manage congestion`);
      recommendations.push(`Consider implementing entry restrictions or time-slot booking`);
      if (criticalPeriodCount > 3) {
        recommendations.push(`Extended critical period detected - plan for continuous staffing`);
      }
    } else if (riskLevel === 'High') {
      recommendations.push(`Increase staff monitoring at Gate ${gateName} during peak times`);
      recommendations.push(`Prepare contingency plans for overflow management`);
      if (capacity < 100) {
        recommendations.push(`Small gate capacity - consider using as VIP/priority entry only`);
      }
    } else if (riskLevel === 'Moderate') {
      recommendations.push(`Standard staffing sufficient with periodic monitoring`);
      if (capacity > 500) {
        recommendations.push(`Consider as primary entry point to distribute load`);
      }
    } else {
      recommendations.push(`Minimal supervision required`);
      recommendations.push(`Can serve as backup/overflow entry point`);
    }

    return recommendations;
  }

  /**
   * Calculates required resources based on forecast
   */
  calculateRequiredResources(gates, totalAttendees) {
    // Security: 1 per 100 attendees minimum, more for high-risk gates
    let securityNeeded = Math.ceil(totalAttendees / 100);
    
    // Medical: 1 per 1000 attendees minimum
    let medicalNeeded = Math.max(2, Math.ceil(totalAttendees / 1000));
    
    // General staff: 2 per gate minimum
    let staffNeeded = gates.length * 2;

    // Add extra for high-risk gates
    const highRiskCount = gates.filter(g => g.riskLevel === 'Critical' || g.riskLevel === 'High').length;
    securityNeeded += highRiskCount * 3;
    staffNeeded += highRiskCount * 2;

    return {
      security: securityNeeded,
      medical: medicalNeeded,
      staff: staffNeeded
    };
  }

  /**
   * Generates a forecast report PDF for an event
   * @param {Object} event - Event data with forecast_result
   * @returns {Promise<Buffer>} - PDF buffer
   */
  async generateForecastReport(event) {
    try {
      logger.info('Generating forecast report', { eventId: event.eventId });

      // Pre-process data
      const processedData = this.preprocessEventData(event);

      return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
          size: 'A4',
          margins: { top: 50, bottom: 50, left: 50, right: 50 }
        });

        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          const pdfBuffer = Buffer.concat(buffers);
          logger.info('PDF generation completed', { 
            eventId: event.eventId,
            size: pdfBuffer.length 
          });
          resolve(pdfBuffer);
        });
        doc.on('error', reject);

        // Generate PDF content with processed data
        this.addReportHeader(doc, event);
        this.addExecutiveSummary(doc, processedData);
        this.addEventInformation(doc, event);
        this.addResourceRequirements(doc, processedData);
        this.addGateAnalysis(doc, processedData);
        this.addRecommendations(doc, processedData);
        this.addReportFooter(doc);

        doc.end();
      });
    } catch (error) {
      logger.error('Error generating forecast report', { 
        eventId: event.eventId, 
        error: error.message 
      });
      throw new Error(`Failed to generate report: ${error.message}`);
    }
  }

  /**
   * Adds report header with title and logo
   */
  addReportHeader(doc, event) {
    // Title
    doc.fontSize(26)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Crowd Management & Safety Report', { align: 'center' });
    
    doc.fillColor('black');
    doc.moveDown(0.3);
    
    // Subtitle
    doc.fontSize(12)
       .font('Helvetica-Oblique')
       .fillColor('#64748b')
       .text('AI-Powered Crowd Forecasting - Event Buddy', { align: 'center' });
    
    doc.fillColor('black');
    doc.moveDown(0.5);
    
    // Event name
    doc.fontSize(18)
       .font('Helvetica-Bold')
       .text(event.name || 'Unnamed Event', { align: 'center' });
    
    doc.moveDown(0.3);
    
    // Report date
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#64748b')
       .text(`Generated on Date: ${new Date().toLocaleDateString('en-US', { 
         year: 'numeric', 
         month: 'long', 
         day: 'numeric' 
       })}`, { align: 'center' });
    
    doc.fillColor('black');
    doc.moveDown(1.5);
    
    // Horizontal line
    doc.moveTo(50, doc.y)
       .lineTo(545, doc.y)
       .lineWidth(2)
       .stroke();
    
    doc.moveDown(1.5);
  }

  /**
   * Adds executive summary section
   */
  addExecutiveSummary(doc, processedData) {
    const insights = processedData.overallInsights;

    doc.fontSize(16)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Executive Summary', 50);
    
    doc.fillColor('black');
    doc.moveDown(0.8);

    // Key highlights box
    const boxY = doc.y;
    doc.save();
    doc.roundedRect(50, boxY, 495, 100, 5)
       .fillAndStroke('#eff6ff', '#3b82f6');
    doc.restore();
    
    doc.fillColor('black');
    doc.fontSize(11)
       .font('Helvetica');
    
    const contentY = boxY + 15;
    
    // Total expected attendees
    doc.font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Total Expected Peak Attendance:', 60, contentY, { width: 250, continued: true })
       .font('Helvetica')
       .fillColor('black')
       .text(` ${insights.totalExpectedAttendees.toLocaleString()} people`, { continued: false });
    
    // High risk gates
    if (insights.highRiskGates.length > 0) {
      doc.font('Helvetica-Bold')
         .fillColor('#1e40af')
         .text('High-Risk Gates Identified:', 60, contentY + 25, { width: 250, continued: true })
         .font('Helvetica')
         .fillColor('black')
         .text(` ${insights.highRiskGates.length} gates require special attention`, { continued: false });
    }
    
    // Resources needed
    doc.font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Recommended Staff Deployment:', 60, contentY + 50, { width: 250, continued: false });
    doc.font('Helvetica')
       .fillColor('black')
       .text(`${insights.requiredResources.security} security, ${insights.requiredResources.medical} medical, ${insights.requiredResources.staff} support staff`, 60, contentY + 65);
    
    doc.fillColor('black');
    doc.y = boxY + 110;
    doc.moveDown(1);

    // Purpose statement
    doc.fontSize(10)
       .font('Helvetica-Oblique')
       .fillColor('#475569')
       .text(
         'The analysis is based on historical data, venue capacity, and predictive modeling.',
         50,
         doc.y,
         { align: 'justify', width: 495 }
       );
    
    doc.fillColor('black');
    doc.moveDown(2);
  }

  /**
   * Adds event basic information section
   */
  addEventInformation(doc, event) {
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Event Details', 50);
    
    doc.fillColor('black');
    doc.moveDown(0.7);
    
    doc.fontSize(10)
       .font('Helvetica');

    const startDate = new Date(event.dateOfEventStart);
    const endDate = new Date(event.dateOfEventEnd);
    const duration = (endDate - startDate) / (1000 * 60 * 60); // hours
    
    this.addInfoRow(doc, 'Venue:', event.venue || 'N/A');
    this.addInfoRow(doc, 'Event Date:', startDate.toLocaleDateString('en-US', { 
      weekday: 'long',
      year: 'numeric',
      month: 'long', 
      day: 'numeric' 
    }));
    this.addInfoRow(doc, 'Start Time:', startDate.toLocaleTimeString('en-US', { 
      hour: '2-digit',
      minute: '2-digit'
    }));
    this.addInfoRow(doc, 'End Time:', endDate.toLocaleTimeString('en-US', { 
      hour: '2-digit',
      minute: '2-digit'
    }));
    this.addInfoRow(doc, 'Duration:', `${duration.toFixed(1)} hours`);
    
    if (event.description) {
      doc.moveDown(0.5);
      doc.fontSize(10)
         .font('Helvetica')
         .fillColor('#475569')
         .text(event.description, 50, doc.y, { align: 'justify', width: 495 });
      doc.fillColor('black');
    }
    
    doc.moveDown(1.5);
  }

  /**
   * Adds resource requirements section
   */
  addResourceRequirements(doc, processedData) {
    const resources = processedData.overallInsights.requiredResources;

    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Requested Resources & Support', 50);
    
    doc.fillColor('black');
    doc.moveDown(0.7);

    doc.fontSize(10)
       .font('Helvetica')
       .text(
          'Following resources below is requested to ensure public safety and smooth event operation:',
          50,
          doc.y,
          { align: 'justify', width: 495 }
       );
    
    doc.moveDown(0.8);

    // Security Personnel Box
    const secBox = doc.y;
    doc.save();
    doc.roundedRect(50, secBox, 240, 70, 5)
       .fillAndStroke('#fef2f2', '#dc2626');
    doc.restore();
    
    doc.fillColor('#dc2626')
       .fontSize(12)
       .font('Helvetica-Bold')
       .text('Security Personnel', 60, secBox + 12, { width: 220 });
    
    doc.fontSize(24)
       .font('Helvetica-Bold')
       .fillColor('#991b1b')
       .text(`${resources.security}`, 60, secBox + 32, { width: 220 });
    
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#7f1d1d')
       .text('officers required', 60, secBox + 58, { width: 220 });

    // Medical Staff Box
    doc.save();
    doc.roundedRect(305, secBox, 240, 70, 5)
       .fillAndStroke('#ecfdf5', '#10b981');
    doc.restore();
    
    doc.fillColor('#059669')
       .fontSize(12)
       .font('Helvetica-Bold')
       .text('Medical Staff', 315, secBox + 12, { width: 220 });
    
    doc.fontSize(24)
       .font('Helvetica-Bold')
       .fillColor('#047857')
       .text(`${resources.medical}`, 315, secBox + 32, { width: 220 });
    
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#065f46')
       .text('personnel required', 315, secBox + 58, { width: 220 });

    doc.fillColor('black');
    doc.y = secBox + 80;
    doc.moveDown(1);

    // Support Staff
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .text(`Additional Support Staff: `, 50, doc.y, { continued: true })
       .font('Helvetica')
       .text(`${resources.staff} personnel for crowd management and assistance`);
    
    doc.moveDown(1);

    // Rationale
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .text('Resource Calculation Rationale:', 50);
    
    doc.moveDown(0.3);
    
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#475569')
       .text('• Security staffing: 1 officer per 100 attendees + additional for high-risk gates', 50, doc.y, { width: 495 })
       .text('• Medical personnel: 1 staff per 1,000 attendees (minimum 2)', 50, doc.y, { width: 495 })
       .text('• Support staff: 2 personnel per gate + extra for critical areas', 50, doc.y, { width: 495 });
    
    doc.fillColor('black');
    doc.moveDown(2);
  }

  /**
   * Helper to add info rows
   */
  addInfoRow(doc, label, value) {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(label, 50, y, { width: 120, continued: false });
    doc.font('Helvetica').text(value, 170, y, { width: 375 });
    doc.moveDown(0.3);
  }

  /**
   * Adds gate analysis section with visual crowd flow representation
   */
  addGateAnalysis(doc, processedData) {
    if (!processedData.gates || processedData.gates.length === 0) {
      doc.fontSize(11)
         .font('Helvetica-Oblique')
         .text('No gate forecast data available.', 50, doc.y, { align: 'center', width: 495 });
      doc.moveDown(1);
      return;
    }

    // Add page break if needed
    if (doc.y > 650) {
      doc.addPage();
    }

    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Gate-by-Gate Analysis', 50);
    
    doc.fillColor('black');
    doc.moveDown(1);

    processedData.gates.forEach((gate, index) => {
      // Check if we have enough space for gate section (header + metrics + chart minimum)
      // Need at least 250px to keep title and content together
      const minSpaceNeeded = 250;
      const pageHeight = 792; // A4 page height in points
      const bottomMargin = 50;
      const availableSpace = pageHeight - bottomMargin - doc.y;
      
      if (availableSpace < minSpaceNeeded) {
        // Not enough space - add page break BEFORE the title
        doc.addPage();
      }

      // Gate header with risk indicator
      const headerY = doc.y;
      doc.save();
      doc.roundedRect(50, headerY, 495, 40, 5)
         .fillAndStroke('#f8fafc', '#cbd5e1');
      doc.restore();
      
      doc.fillColor('black')
         .fontSize(13)
         .font('Helvetica-Bold')
         .text(`Gate ${gate.name}`, 60, headerY + 12, { width: 350 });
      
      // Risk badge - draw separately
      doc.save();
      doc.roundedRect(420, headerY + 10, 115, 22, 10)
         .lineWidth(1.5)
         .fillAndStroke(gate.riskColor + '30', gate.riskColor);
      doc.restore();
      
      doc.fillColor(gate.riskColor)
         .fontSize(10)
         .font('Helvetica-Bold')
         .text(`${gate.riskLevel} Risk`, 425, headerY + 15, { width: 105, align: 'center' });
      
      doc.fillColor('black');
      doc.y = headerY + 45;
      doc.moveDown(0.5);

      // Key metrics in 3 columns
      const metricsY = doc.y;
      
      // Capacity
      doc.fontSize(9)
         .font('Helvetica')
         .fillColor('#64748b')
         .text('Capacity', 60, metricsY);
      doc.fontSize(16)
         .font('Helvetica-Bold')
         .fillColor('black')
         .text(gate.capacity, 60, metricsY + 12);
      
      // Peak Time & Count
      doc.fontSize(9)
         .font('Helvetica')
         .fillColor('#64748b')
         .text('Peak Time', 220, metricsY);
      doc.fontSize(11)
         .font('Helvetica-Bold')
         .fillColor('black')
         .text(`${gate.peak.time}`, 220, metricsY + 12);
      doc.fontSize(9)
         .font('Helvetica')
         .fillColor('#dc2626')
         .text(`${gate.peak.count} people (${gate.peak.utilization}%)`, 220, metricsY + 28);
      
      // Average
      doc.fontSize(9)
         .font('Helvetica')
         .fillColor('#64748b')
         .text('Avg Crowd', 400, metricsY);
      doc.fontSize(16)
         .font('Helvetica-Bold')
         .fillColor('black')
         .text(gate.average, 400, metricsY + 12);
      
      doc.fillColor('black');
      doc.moveDown(3.5);

      // Simple bar chart visualization
      doc.fillColor('black')
         .fontSize(10)
         .font('Helvetica-Bold')
         .text('Crowd Flow Timeline (30-min intervals):', 50);
      doc.moveDown(0.5);

      const chartY = doc.y;
      const chartX = 60;
      const chartWidth = 480;
      const chartHeight = 70;

      // Check if we have data
      if (!gate.timeSeriesData || gate.timeSeriesData.length === 0) {
        doc.fontSize(9)
           .font('Helvetica-Oblique')
           .fillColor('#64748b')
           .text('No timeline data available for this gate.', 50, chartY + 30);
        doc.fillColor('black');
        doc.y = chartY + chartHeight;
        doc.moveDown(1);
      } else {
        // Calculate max for scaling
        const maxCount = Math.max(
          ...gate.timeSeriesData.map(d => d.count),
          gate.capacity || 1,
          1
        );

        // Draw chart background with border
        doc.save();
        doc.rect(chartX, chartY, chartWidth, chartHeight)
           .lineWidth(1)
           .strokeColor('#cbd5e1')
           .fillAndStroke('#f8fafc', '#cbd5e1');
        doc.restore();

        // Draw bars
        const dataPoints = gate.timeSeriesData.length;
        const barSpacing = 2;
        const barWidth = Math.max(3, Math.floor((chartWidth - (dataPoints - 1) * barSpacing) / dataPoints));
        
        logger.info('Drawing chart', { 
          gate: gate.name, 
          dataPoints, 
          barWidth, 
          maxCount,
          firstPoint: gate.timeSeriesData[0]
        });

        for (let i = 0; i < gate.timeSeriesData.length; i++) {
          const point = gate.timeSeriesData[i];
          if (point.count > 0) {
            const barHeight = Math.max(3, (point.count / maxCount) * (chartHeight - 4));
            const x = chartX + 2 + (i * (barWidth + barSpacing));
            const y = chartY + chartHeight - barHeight - 2;
            
            // Color based on percentage
            let barColor = '#10b981'; // Low (green)
            const pct = parseFloat(point.percentage);
            if (pct >= 90) barColor = '#ef4444'; // Critical (red)
            else if (pct >= 70) barColor = '#f59e0b'; // High (orange)
            else if (pct >= 50) barColor = '#3b82f6'; // Moderate (blue)
            
            // Draw each bar
            doc.save();
            doc.rect(x, y, barWidth, barHeight)
               .fillAndStroke(barColor, barColor);
            doc.restore();
          }
        }

        // Draw capacity reference line
        if (gate.capacity > 0 && gate.capacity <= maxCount) {
          const capY = chartY + chartHeight - ((gate.capacity / maxCount) * (chartHeight - 4)) - 2;
          doc.save();
          doc.moveTo(chartX + 2, capY)
             .lineTo(chartX + chartWidth - 2, capY)
             .dash(4, { space: 2 })
             .strokeColor('#dc2626')
             .lineWidth(1.5)
             .stroke();
          doc.restore();
          doc.undash();
          
          // Add capacity label
          doc.fontSize(7)
             .fillColor('#dc2626')
             .text('Capacity', chartX + chartWidth - 45, capY - 10);
        }

        doc.fillColor('black');
        doc.strokeColor('black');
        doc.y = chartY + chartHeight + 5;

        // Add X-axis time labels (show every 3rd time point for clarity)
        doc.fontSize(7)
           .fillColor('#64748b');
        
        for (let i = 0; i < gate.timeSeriesData.length; i += 3) {
          const point = gate.timeSeriesData[i];
          const x = chartX + 2 + (i * (barWidth + barSpacing));
          
          // Extract time from timestamp (e.g., "2025-10-21 08:00:00" -> "08:00")
          const timeStr = point.time.split(' ')[1] ? point.time.split(' ')[1].substring(0, 5) : point.time;
          
          // Draw time label
          doc.text(timeStr, x - 8, chartY + chartHeight + 8, { width: 30, align: 'center' });
        }

        doc.fillColor('black');
        doc.y = chartY + chartHeight + 20;
        doc.moveDown(1);
      }

      // Removed critical periods text list - info is already visible in the chart

      doc.moveDown(0.8);
    });

    doc.moveDown(1);
  }

  /**
   * Adds recommendations section
   */
  addRecommendations(doc, processedData) {
    if (!processedData.gates || processedData.gates.length === 0) {
      return;
    }

    // Check if we have enough space for the section (title + content)
    const minSpaceNeeded = 150;
    const pageHeight = 792;
    const bottomMargin = 50;
    const availableSpace = pageHeight - bottomMargin - doc.y;
    
    if (availableSpace < minSpaceNeeded) {
      doc.addPage();
    }

    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('Operational Recommendations', 50);
    
    doc.fillColor('black');
    doc.moveDown(1);

    doc.fontSize(10)
       .font('Helvetica')
       .text(
         'Based on the crowd forecasting analysis, we recommend the following actions for each entry point:',
         50,
         doc.y,
         { align: 'justify', width: 495 }
       );
    
    doc.moveDown(1);

    processedData.gates.forEach((gate, index) => {
      // Check if we have enough space for gate recommendation section
      const minSpaceNeeded = 80; // Enough for title + at least 2 recommendations
      const pageHeight = 792;
      const bottomMargin = 50;
      const availableSpace = pageHeight - bottomMargin - doc.y;
      
      if (availableSpace < minSpaceNeeded) {
        doc.addPage();
      }

      // Gate name with risk badge
      doc.fontSize(12)
         .font('Helvetica-Bold')
         .text(`Gate ${gate.name}`, 50, doc.y, { continued: true });
      
      doc.fontSize(10)
         .font('Helvetica')
         .fillColor(gate.riskColor)
         .text(` [${gate.riskLevel} Risk]`, { continued: false });
      
      doc.fillColor('black');
      doc.moveDown(0.4);

      // Recommendations
      doc.fontSize(9)
         .font('Helvetica');
      
      gate.recommendations.forEach((rec, i) => {
        doc.text(`${i + 1}. ${rec}`, 50, doc.y, { indent: 10, width: 495 });
      });

      doc.moveDown(0.8);
    });

    // Overall recommendations
    doc.moveDown(0.5);
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .text('General Recommendations:', 50);
    
    doc.moveDown(0.4);
    
    doc.fontSize(9)
       .font('Helvetica')
       .text('• Deploy staff 30 minutes before peak periods to prepare crowd control measures', 50, doc.y, { indent: 10, width: 495 })
       .text('• Establish clear communication channels between all gate supervisors', 50, doc.y, { indent: 10, width: 495 })
       .text('• Prepare contingency plans for overflow scenarios at high-risk gates', 50, doc.y, { indent: 10, width: 495 })
       .text('• Conduct briefing session with all staff before event commencement', 50, doc.y, { indent: 10, width: 495 })
       .text('• Set up emergency evacuation routes and ensure all staff are aware', 50, doc.y, { indent: 10, width: 495 });

    doc.moveDown(2);
  }

  /**
   * OLD METHOD - kept for reference, not used
   */
  _oldAddDetailedForecast(doc, event) {
    const forecastResult = event.forecastResult;
    
    if (!forecastResult || !forecastResult.forecast) {
      return;
    }

    doc.fontSize(14)
       .font('Helvetica-Bold')
       .text('Detailed Forecast by Gate');
    
    doc.moveDown(0.5);

    const forecast = forecastResult.forecast;
    const gates = Object.keys(forecast);

    gates.forEach((gate, index) => {
      const gateData = forecast[gate];
      
      // Check if we have enough space for gate section (header + table header + few rows)
      const minSpaceNeeded = 120; // Enough for title + table header
      const pageHeight = 792;
      const bottomMargin = 50;
      const availableSpace = pageHeight - bottomMargin - doc.y;
      
      if (availableSpace < minSpaceNeeded) {
        doc.addPage();
      }

      // Gate header
      doc.fontSize(12)
         .font('Helvetica-Bold')
         .fillColor('#2563eb')
         .text(`Gate ${gate}`, { underline: true });
      
      doc.fillColor('black');
      doc.moveDown(0.3);

      // Gate capacity
      if (gateData.capacity) {
        doc.fontSize(10)
           .font('Helvetica')
           .text(`Capacity: ${gateData.capacity} people`);
        doc.moveDown(0.3);
      }

      // Timeframe data
      if (gateData.timeFrames && gateData.timeFrames.length > 0) {
        doc.fontSize(10)
           .font('Helvetica-Bold')
           .text(`Forecast Data (${gateData.timeFrames.length} timeframes):`);
        
        doc.moveDown(0.3);

        // Create table header
        const tableTop = doc.y;
        const timeCol = 50;
        const countCol = 150;
        const capacityCol = 250;
        const statusCol = 350;
        
        doc.fontSize(9)
           .font('Helvetica-Bold');
        
        doc.text('Time', timeCol, tableTop, { width: 90, align: 'left' });
        doc.text('Forecast Count', countCol, tableTop, { width: 90, align: 'right' });
        doc.text('% Capacity', capacityCol, tableTop, { width: 90, align: 'right' });
        doc.text('Status', statusCol, tableTop, { width: 150, align: 'left' });
        
        doc.moveDown(0.5);
        
        // Draw header line
        doc.moveTo(timeCol, doc.y)
           .lineTo(500, doc.y)
           .stroke();
        
        doc.moveDown(0.3);

        // Add timeframe rows (limit to prevent overflow)
        const maxRows = 20;
        const timeframes = gateData.timeFrames.slice(0, maxRows);
        
        doc.fontSize(8)
           .font('Helvetica');
        
        timeframes.forEach((tf, i) => {
          if (doc.y > 720) {
            doc.addPage();
            doc.y = 50;
          }

          const rowY = doc.y;
          const count = Math.round(tf.yhat || 0);
          const percentCapacity = gateData.capacity > 0 
            ? ((count / gateData.capacity) * 100).toFixed(1) 
            : 0;
          
          // Determine status color
          let status = 'Normal';
          let statusColor = '#10b981'; // green
          
          if (percentCapacity >= 90) {
            status = 'Critical';
            statusColor = '#ef4444'; // red
          } else if (percentCapacity >= 70) {
            status = 'High';
            statusColor = '#f59e0b'; // orange
          } else if (percentCapacity >= 50) {
            status = 'Moderate';
            statusColor = '#3b82f6'; // blue
          }

          doc.fillColor('black')
             .text(tf.time || `T+${i*5}min`, timeCol, rowY, { width: 90 });
          doc.text(count.toString(), countCol, rowY, { width: 90, align: 'right' });
          doc.text(`${percentCapacity}%`, capacityCol, rowY, { width: 90, align: 'right' });
          doc.fillColor(statusColor)
             .text(status, statusCol, rowY, { width: 150 });
          doc.fillColor('black');
          
          doc.moveDown(0.4);
        });

        if (gateData.timeFrames.length > maxRows) {
          doc.fontSize(8)
             .font('Helvetica-Oblique')
             .fillColor('#6b7280')
             .text(`... and ${gateData.timeFrames.length - maxRows} more timeframes`, { align: 'center' });
          doc.fillColor('black');
        }
      }

      doc.moveDown(1);
    });
  }

  /**
   * Adds report footer
   */
  addReportFooter(doc) {
    // Add signature section
    doc.moveDown(2);
    
    const signY = doc.y;
    
    // Organizer signature
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .text('Prepared by:', 60, signY);
    
    doc.fontSize(9)
       .font('Helvetica')
       .text('____________________________', 60, signY + 30);
    
    doc.fontSize(8)
       .fillColor('#64748b')
       .text('Event Organizer', 60, signY + 45);
    
    // Authority acknowledgement
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .fillColor('black')
       .text('For Official Use:', 320, signY);
    
    doc.fontSize(9)
       .font('Helvetica')
       .text('____________________________', 320, signY + 30);
    
    doc.fontSize(8)
       .fillColor('#64748b')
       .text('Authorized Officer', 320, signY + 45);
    
    doc.fillColor('black');
    doc.moveDown(1.5);
    
    // Disclaimer
    const bottomMargin = 70;
    const pageHeight = doc.page.height;
    
    doc.fontSize(7)
       .font('Helvetica-Oblique')
       .fillColor('#9ca3af')
       .text(
         'This report is generated using AI-powered crowd forecasting models. Actual crowd behavior may vary. ' +
         'This document is provided to support resource planning and should be used in conjunction with ' +
         'professional event management expertise.',
         50,
         pageHeight - bottomMargin,
         { align: 'center', width: 495 }
       );
    
    doc.fillColor('black');
  }

  /**
   * Formats a forecast report filename
   * @param {Object} event - Event data
   * @returns {string} - Formatted filename
   */
  getReportFilename(event) {
    const eventName = (event.name || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
    
    const timestamp = new Date().toISOString().split('T')[0];
    return `forecast-report-${eventName}-${timestamp}.pdf`;
  }
}

module.exports = new ReportService();

