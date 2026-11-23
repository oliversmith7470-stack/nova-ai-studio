/*
 * NOVA MOTION — Generation API
 * Stage 3 integration foundation
 *
 * Provider target: self-hosted Wan 2.2 on Modal.
 * No provider is activated until its endpoint,
 * authentication and request contract are verified.
 */

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        status: "failed",
        message: "Method not allowed."
      })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const plan = body.plan;

    if (
      !plan ||
      !Array.isArray(plan.scenes) ||
      plan.scenes.length === 0
    ) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          status: "failed",
          message: "A valid scene plan is required."
        })
      };
    }

    /*
     * Provider adapter activation is deliberately withheld.
     * Do not report a queued job until a real provider
     * accepts the generation request.
     */

    const providerConfigured =
      Boolean(process.env.WAN22_MODAL_ENDPOINT) &&
      Boolean(process.env.WAN22_MODAL_API_KEY);

    if (!providerConfigured) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          status: "unavailable",
          provider: "wan22-modal",
          message:
            "NOVA Motion received your production plan, but the Wan 2.2 provider is not configured yet. No video has been generated."
        })
      };
    }

    return {
      statusCode: 501,
      headers,
      body: JSON.stringify({
        status: "unavailable",
        provider: "wan22-modal",
        message:
          "Provider credentials are present, but the verified Wan 2.2 request adapter has not been implemented. No generation request was sent."
      })
    };

  } catch (error) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        status: "failed",
        message: "Invalid production request."
      })
    };
  }
};
