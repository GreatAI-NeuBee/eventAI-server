// services/bedrockService.js
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");
const { generateRecommendationPrompt } = require("../utils/promptGenerator");

const client = new BedrockRuntimeClient({ region: process.env.AWS_BEDROCK_REGION });

async function getIncidentRecommendation(forecastResult, forecastData) {
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
        const response = await client.send(command);

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

module.exports = { getIncidentRecommendation };
