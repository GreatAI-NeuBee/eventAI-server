// utils/promptGenerator.js
function generateRecommendationPrompt(forecastResult, eventInfo) {
    const { gates, schedule_start_time, event_end_time, method_exits, freq } = eventInfo;

    // forecastResult should have structure: { forecast: {...}, summary: {...}, metadata: {...} }
    if (!forecastResult || !forecastResult.forecast) {
        return `You are an AI congestion advisor for event organizers.

IMPORTANT: The forecast data is incomplete or invalid. Please respond with ONLY this JSON structure:

{
  "gates": [],
  "generalRecommendations": [
    "Forecast data is incomplete - unable to generate specific recommendations",
    "Please ensure forecast data is properly generated before requesting incident analysis",
    "General safety measures should still be followed: adequate staffing, clear signage, emergency protocols"
  ]
}

Do not provide any additional text or explanations. Only output valid JSON.`;
    }

    // Prepare detailed per-gate analysis
    const gateSummaries = Object.entries(forecastResult.forecast).map(([gate, data]) => {
        const timeFrames = data.timeFrames || [];
        const capacity = data.capacity || 0;
        
        // Calculate key metrics
        const peakCrowd = Math.max(...timeFrames.map(tf => tf.yhat || 0));
        const avgCrowd = timeFrames.reduce((sum, tf) => sum + (tf.yhat || 0), 0) / (timeFrames.length || 1);
        const utilizationRate = capacity > 0 ? ((peakCrowd / capacity) * 100).toFixed(1) : 0;
        
        // Find times where crowd >= 80% of capacity (high risk)
        const highRiskTimes = timeFrames
            .filter(tf => tf.yhat >= 0.8 * capacity)
            .map(tf => ({ time: tf.time, crowd: Math.round(tf.yhat), percentage: ((tf.yhat / capacity) * 100).toFixed(0) }));
        
        // Find times where crowd >= 90% of capacity (critical risk)
        const criticalRiskTimes = timeFrames
            .filter(tf => tf.yhat >= 0.9 * capacity)
            .map(tf => ({ time: tf.time, crowd: Math.round(tf.yhat) }));
        
        // Find peak hour
        const peakTimeFrame = timeFrames.reduce((max, tf) => 
            (tf.yhat > (max.yhat || 0)) ? tf : max, 
            timeFrames[0] || { time: 'N/A', yhat: 0 }
        );
        
        return {
            gate,
            capacity,
            peakCrowd: Math.round(peakCrowd),
            avgCrowd: Math.round(avgCrowd),
            utilizationRate,
            peakTime: peakTimeFrame.time,
            highRiskTimes,
            criticalRiskTimes,
            totalTimeFrames: timeFrames.length
        };
    });

    // Build detailed summary for AI with specific data for each gate
    const summaryText = gateSummaries.map(g => `
Gate ${g.gate}:
  - Capacity: ${g.capacity} people
  - Peak crowd: ${g.peakCrowd} people at ${g.peakTime} (${g.utilizationRate}% capacity)
  - Average crowd: ${g.avgCrowd} people
  - High risk periods (≥80% capacity): ${g.highRiskTimes.length > 0 ? g.highRiskTimes.map(t => `${t.time} (${t.crowd} people, ${t.percentage}%)`).join(", ") : "None"}
  - Critical risk periods (≥90% capacity): ${g.criticalRiskTimes.length > 0 ? g.criticalRiskTimes.map(t => `${t.time} (${t.crowd} people)`).join(", ") : "None"}
  - Total forecast timeframes: ${g.totalTimeFrames}
`).join("\n");

    return `You are an AI congestion advisor for event organizers. Analyze the forecast data and provide incident prevention recommendations.

Event Details:
- Gates: ${gates.join(", ")}
- Schedule: ${schedule_start_time} → ${event_end_time}
- Forecast Frequency: ${freq}
- Exit Estimation Method: ${method_exits}

Forecast Summary (per gate):
${summaryText}

⚠️ CRITICAL INSTRUCTIONS:
1. You MUST respond with ONLY valid JSON. No markdown, no explanations, no extra text.
2. Analyze EACH gate separately based on its UNIQUE data (capacity, peak times, crowd levels)
3. Provide DIFFERENT recommendations for each gate based on their specific risk profiles
4. Gates with higher utilization rates need MORE DETAILED and STRICTER recommendations
5. Consider the capacity differences: small gates (50) vs large gates (800+)

Required JSON Structure:
{
  "gates": [
    {
      "gate": "A",
      "expectedCongestionTimes": ["14:00", "15:30"],
      "recommendedActions": [
        "Deploy 3 additional staff members at peak time (14:00)",
        "Install temporary crowd barriers 30 minutes before peak",
        "Implement one-way flow system if crowd exceeds 700"
      ],
      "possibleIncidents": [
        "Crowd crush at 14:00 when reaching 1200 people (150% capacity)",
        "Bottleneck at entrance during 15:30 surge"
      ]
    },
    {
      "gate": "1",
      "expectedCongestionTimes": [],
      "recommendedActions": [
        "Maintain 1 staff member for monitoring",
        "Use as overflow gate if other gates become congested"
      ],
      "possibleIncidents": [
        "Minor delays possible",
        "Equipment malfunction"
      ]
    }
  ],
  "generalRecommendations": [
    "Ensure all emergency exits are clearly marked and accessible",
    "Station medical personnel at central locations between gates A and B",
    "Implement real-time crowd monitoring for high-capacity gates (A, B)"
  ]
}

KEY ANALYSIS RULES:
- High utilization (>90%): CRITICAL - require multiple staff, barriers, emergency protocols
- Medium utilization (70-90%): WARNING - require monitoring, flexible staffing
- Low utilization (<70%): NORMAL - standard procedures, minimal staffing
- Large capacity gates (800+): More staff, wider bottlenecks possible
- Small capacity gates (50): Congestion happens faster, quicker response needed

Output ONLY the JSON object. Start with { and end with }`;

}

module.exports = { generateRecommendationPrompt };
