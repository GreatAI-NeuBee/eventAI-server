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

      // Construct the prompt for Nova Lite - focused on key operational data
      const prompt = `You are an event operations analyst. Analyze this event and provide focused operational insights.

Event Details:
- Type: ${type}
- Featured: ${feat}
- Location: ${location}

⚠️ CRITICAL: Respond with ONLY valid JSON. No markdown, no explanations.

Required JSON Structure:
{
  "popularityScore": <number 0-100>,
  "popularityLevel": <"Very High" | "High" | "Medium" | "Low">,
  "audienceDemographics": {
    "ageGroups": {
      "children": <percentage 0-100>,
      "teens": <percentage 0-100>,
      "youngAdults": <percentage 0-100>,
      "middleAged": <percentage 0-100>,
      "seniors": <percentage 0-100>
    },
    "primaryAgeRange": <"25-45 years old">,
    "mobilityConsiderations": <string describing mobility needs>,
    "behaviorProfile": <string describing expected behavior>
  },
  "crowdFlowAnalysis": {
    "entrySpeed": <"Fast" | "Moderate" | "Slow">,
    "entrySpeedRationale": <detailed explanation based on demographics>
  },
  "historicalIncidents": [
    {
      "incident": <description of past incident at similar events>,
      "date": <date or "Unknown">,
      "casualties": <impact description>,
      "cause": <root cause>
    }
  ],
  "operationalRecommendations": {
    "staffingRequirements": {
      "securityPersonnel": <number>,
      "medicalStaff": <number>,
      "crowdControlOfficers": <number>,
      "assistanceStaff": <number for elderly/disabled>,
      "rationale": <explain staffing based on demographics>
    },
    "entranceManagement": [
      <SPECIFIC recommendations tailored to audience demographics>
      <Example: If 20% seniors: "Open gates 2 hours early for seniors and disabled">
      <Example: If 40% teens: "Implement digital ticketing to speed up entry">
    ],
    "crowdControl": [
      <DEMOGRAPHIC-SPECIFIC crowd control measures>
      <Example: If elderly present: "Install handrails along queue areas">
      <Example: If young energetic crowd: "Deploy extra barriers at surge-prone areas">
    ],
    "emergencyPreparedness": [
      <TAILORED emergency measures for this audience>
      <Example: If seniors: "Station medical staff near seating areas, stock heart medications">
      <Example: If young adults: "Prepare for heat exhaustion, dehydration">
    ],
    "specialConsiderations": [
      <CRITICAL considerations based on age groups and behavior profile>
      <Must reference specific percentages from audienceDemographics>
    ]
  }
}

CRITICAL INSTRUCTIONS FOR OPERATIONAL RECOMMENDATIONS:
1. **Analyze the audienceDemographics percentages carefully**
2. **Tailor EVERY recommendation to the specific demographic profile**
3. **If 15%+ seniors**: Include wheelchair access, early entry, handrails, seating, medical focus on heart/mobility issues
4. **If 30%+ teens/youngAdults**: Focus on crowd surge control, faster entry systems, heat/dehydration, energy management
5. **If 20%+ children**: Add parent zones, slower processing, child-friendly facilities
6. **Always reference specific age group percentages in rationale**
7. **Make recommendations ACTIONABLE and SPECIFIC**

Example for senior-heavy audience:
- "With 35% seniors, deploy 15 assistance staff specifically for mobility support"
- "Provide seating areas every 50 meters due to 35% senior attendance"
- "Medical staff should focus on cardiovascular issues common in 50+ demographic"

Output ONLY the JSON. Start with { and end with }`;

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

        // Fallback: return a basic analysis if JSON parsing fails (focused on key fields only)
        analysisResult = {
          popularityScore: 50,
          popularityLevel: "Medium",
          audienceDemographics: {
            ageGroups: {
              children: 0,
              teens: 0,
              youngAdults: 0,
              middleAged: 0,
              seniors: 0
            },
            primaryAgeRange: "Unknown - manual review required",
            mobilityConsiderations: "Unable to analyze automatically",
            behaviorProfile: "Please review manually"
          },
          crowdFlowAnalysis: {
            entrySpeed: "Moderate",
            entrySpeedRationale: "Automated analysis failed - default to moderate speed. Manual assessment recommended based on actual audience demographics."
          },
          historicalIncidents: [],
          operationalRecommendations: {
            staffingRequirements: {
              securityPersonnel: 0,
              medicalStaff: 0,
              crowdControlOfficers: 0,
              assistanceStaff: 0,
              rationale: "AI analysis failed. Please conduct manual staffing assessment based on expected attendance and venue capacity."
            },
            entranceManagement: [
              "Manual review required - AI analysis unavailable",
              "Assess audience demographics before determining entry procedures"
            ],
            crowdControl: [
              "Conduct on-site assessment",
              "Follow venue standard crowd control protocols"
            ],
            emergencyPreparedness: [
              "Develop emergency plan based on venue capacity",
              "Ensure medical staff availability regardless of analysis"
            ],
            specialConsiderations: [
              "AI demographic analysis failed",
              "Manual demographic assessment critical for planning"
            ]
          },
          _error: "JSON parsing failed",
          _rawPreview: content.substring(0, 200)
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

      // Return a fallback response instead of throwing (focused on key fields)
      return {
        error: true,
        errorMessage: error.message,
        popularityScore: 0,
        popularityLevel: "Unknown",
        audienceDemographics: {
          ageGroups: {
            children: 0,
            teens: 0,
            youngAdults: 0,
            middleAged: 0,
            seniors: 0
          },
          primaryAgeRange: "Analysis failed - manual review required",
          mobilityConsiderations: "Unable to determine due to error",
          behaviorProfile: "Analysis error occurred"
        },
        crowdFlowAnalysis: {
          entrySpeed: "Moderate",
          entrySpeedRationale: `Analysis failed due to error: ${error.message}. Default to moderate entry speed. Conduct manual assessment based on expected demographics.`
        },
        historicalIncidents: [],
        operationalRecommendations: {
          staffingRequirements: {
            securityPersonnel: 0,
            medicalStaff: 0,
            crowdControlOfficers: 0,
            assistanceStaff: 0,
            rationale: `AI analysis error: ${error.message}. Manual staffing assessment required based on venue capacity and expected attendance.`
          },
          entranceManagement: [
            "AI analysis unavailable - manual planning required",
            "Assess expected demographics before determining entry procedures",
            `Error details: ${error.message}`
          ],
          crowdControl: [
            "Follow venue standard protocols",
            "Conduct on-site demographic assessment",
            "Retry AI analysis if needed"
          ],
          emergencyPreparedness: [
            "Develop emergency plan based on venue requirements",
            "Ensure medical staff availability",
            "Follow local safety regulations"
          ],
          specialConsiderations: [
            "AI demographic analysis failed - critical manual review needed",
            "Consider event type and featured artist when planning",
            "Consult with venue safety team"
          ]
        },
        metadata: {
          analyzedAt: new Date().toISOString(),
          error: error.message,
          errorCode: error.name
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
          temperature: 0.3,  // Lower temperature for more consistent JSON output
          topP: 0.9,
          maxTokens: 2000    // Increased for detailed recommendations
        },
        system: [
          {
            text: "You are a JSON-only API that returns incident prevention recommendations. You MUST respond with ONLY valid JSON. Do not include any explanations, markdown formatting, or text outside the JSON structure."
          }
        ]
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

        logger.info('Bedrock raw response for incident recommendation', {
          responseLength: outputText.length,
          startsWithBrace: outputText.trim().startsWith('{'),
          preview: outputText.substring(0, 100)
        });

        // Clean up the response text
        // 1. Remove markdown code fences
        outputText = outputText.replace(/^```json\s*/gm, "").replace(/\s*```$/gm, "").trim();
        
        // 2. Remove any leading/trailing text before/after JSON
        const jsonMatch = outputText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          outputText = jsonMatch[0];
        }

        // 3. Try to parse JSON
        recommendationJSON = JSON.parse(outputText);

        // Ensure always has gates & generalRecommendations
        recommendationJSON.gates = recommendationJSON.gates || [];
        recommendationJSON.generalRecommendations = recommendationJSON.generalRecommendations || [];

        logger.info('Incident recommendation parsed successfully', {
          gatesCount: recommendationJSON.gates.length,
          recommendationsCount: recommendationJSON.generalRecommendations.length
        });

      } catch (jsonErr) {
        logger.warn("AI returned invalid JSON, returning fallback structure", { 
          error: jsonErr.message,
          preview: parsed.output?.message?.content?.[0]?.text?.substring(0, 200)
        });
        
        recommendationJSON = {
          gates: [],
          generalRecommendations: [
            "AI incident analysis returned invalid format",
            "Please retry the forecast generation",
            "Manual safety review recommended"
          ],
          error: "JSON parsing failed",
          errorDetails: jsonErr.message
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
