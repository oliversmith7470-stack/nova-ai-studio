exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "https://nova-ai-studio-5r8o.netlify.app",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  const respond = (statusCode, data) => ({
    statusCode,
    headers,
    body: JSON.stringify(data)
  });

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Only POST requests are allowed." });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return respond(500, { error: "AI service is not configured." });
    }

    const body = JSON.parse(event.body || "{}");
    const prompt = typeof body.prompt === "string"
      ? body.prompt.trim()
      : "";

    if (!prompt) {
      return respond(400, { error: "Please enter a writing prompt." });
    }

    if (prompt.length > 4000) {
      return respond(400, {
        error: "Your prompt is too long. Maximum is 4,000 characters."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1200
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", result);
      return respond(502, {
        error: "The AI service could not complete your request. Please try again."
      });
    }

    const generatedText = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!generatedText) {
      return respond(502, {
        error: "The AI returned an empty response. Please try again."
      });
    }

    return respond(200, { text: generatedText });

  } catch (error) {
    console.error("Function error:", error);

    return respond(500, {
      error: "Something went wrong. Please try again."
    });
  }
};
