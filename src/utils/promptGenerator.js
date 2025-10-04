// utils/promptGenerator.js
function generateRecommendationPrompt(forecastData, eventInfo) {
    const { gates, schedule_start_time, event_end_time, method_exits, freq } = eventInfo;

    if (!forecastData || !forecastData.forecastResult || !forecastData.forecastResult.forecast) {
        return JSON.stringify({
            gates: [],
            generalRecommendations: [
                "Forecast data missing or invalid — cannot generate detailed recommendations"
            ]
        });
    }

    // Prepare per-gate summary with expected congestion times
    const gateSummaries = Object.entries(forecastData.forecastResult.forecast).map(([gate, data]) => {
        const timeFrames = data.timeFrames.map(tf => ({
            time: tf.time,           // should be in "HH:MM" format
            predictedCrowd: tf.yhat,
            capacity: data.capacity
        }));

        // Find times where crowd >= 80% of capacity
        const expectedCongestionTimes = timeFrames
            .filter(tf => tf.predictedCrowd >= 0.8 * data.capacity)
            .map(tf => tf.time);

        // Provide basic recommendations even if no congestion
        const recommendedActions = expectedCongestionTimes.length > 0
            ? ["Deploy staff to assist during congestion times", "Ensure signage is clear and visible", "Keep gate operational"]
            : ["Ensure gate is staffed and operational", "Check signage and equipment before event starts"];

        // Possible incidents
        const possibleIncidents = expectedCongestionTimes.length > 0
            ? ["Unexpected crowd surge", "Technical issues with entry systems"]
            : ["Minor delays", "Staff absence"];

        return {
            gate,
            expectedCongestionTimes,
            recommendedActions,
            possibleIncidents
        };
    });

    // Build a JSON-like summary for AI
    const summaryText = gateSummaries.map(g => `
Gate ${g.gate} (Capacity: ${forecastData.forecastResult.forecast[g.gate].capacity}):
- Expected congestion times: ${g.expectedCongestionTimes.length > 0 ? g.expectedCongestionTimes.join(", ") : "None"}
`).join("\n");

    return `
You are an AI congestion advisor for event organizers.

Event Details:
- Gates: ${gates.join(", ")}
- Schedule: ${schedule_start_time} → ${event_end_time}
- Forecast Frequency: ${freq}
- Exit Estimation Method: ${method_exits}

Forecast Summary (per gate):
${summaryText}

STRICTLY RESPOND ONLY IN JSON with this structure:

{
  "gates": [
    {
      "gate": "Gate Name",
      "expectedCongestionTimes": ["HH:MM", ...],
      "recommendedActions": ["action1", "action2"],
      "possibleIncidents": ["incident1", "incident2"]
    }
  ],
  "generalRecommendations": ["Recommendation 1", "Recommendation 2"]
}

IMPORTANT:
- Always include **gate-specific recommendations** even if congestion times are empty.
- Only output valid JSON. No extra explanations.
- General recommendations should cover overall event safety and operations.
`;
}

module.exports = { generateRecommendationPrompt };
