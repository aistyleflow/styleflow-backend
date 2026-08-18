const { GoogleGenAI } = require("@google/genai");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn("⚠️ GEMINI_API_KEY is not configured");
}

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

const MODEL = "gemini-3.6-flash";

/**
 * Send a downloaded WhatsApp voice message to Gemini
 * and extract the customer's requested product, size and quantity.
 *
 * @param {Buffer} audioBuffer - Audio downloaded from Meta
 * @param {string} mimeType - MIME type returned by Meta
 * @returns {Promise<object>}
 */
async function understandVoiceOrder(audioBuffer, mimeType) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
    throw new Error("Invalid or missing audio buffer");
  }

  if (!mimeType) {
    throw new Error("Missing audio MIME type");
  }

  if (!ai) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  console.log("🧠 Sending voice audio to Gemini...");

  const audioBase64 = audioBuffer.toString("base64");

  const prompt = `
You are the voice-order understanding system for StyleFlow, a WhatsApp commerce platform for clothing stores.

Listen carefully to the customer's voice message.

The customer may speak:
- English
- Tamil
- Tanglish
- a mixture of Tamil and English

Understand the customer's intended clothing/product request.

Extract ONLY these fields:

1. product_query
   - The product the customer wants.
   - Keep useful descriptive words.
   - Do not invent a product.

2. size
   - The requested clothing size if clearly mentioned.
   - Examples: S, M, L, XL, XXL.
   - If the customer does not mention a size, return null.

3. quantity
   - The number of items requested if clearly mentioned.
   - If the customer does not mention a quantity, return null.
   - Do not guess a quantity.

4. understood
   - true if the customer's request can be understood sufficiently.
   - false if the audio is too unclear to determine the request.

IMPORTANT:
- Never invent product names.
- Never invent sizes.
- Never invent quantities.
- Do not determine price.
- Do not determine product availability.
- Do not determine product ID.
- Do not create an order.
- Do not add anything to a cart.
- You are ONLY interpreting the customer's voice.

Return ONLY valid JSON.

Required JSON structure:

{
  "product_query": "string or null",
  "size": "string or null",
  "quantity": "number or null",
  "understood": true
}
`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt
            },
            {
              inlineData: {
                mimeType: mimeType,
                data: audioBase64
              }
            }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            product_query: {
              type: ["string", "null"]
            },
            size: {
              type: ["string", "null"]
            },
            quantity: {
              type: ["number", "null"]
            },
            understood: {
              type: "boolean"
            }
          },
          required: [
            "product_query",
            "size",
            "quantity",
            "understood"
          ]
        },
        temperature: 0
      }
    });

    const rawText = response.text;

    if (!rawText) {
      throw new Error("Gemini returned an empty response");
    }

    console.log("🧠 Gemini raw response received");

    let result;

    try {
      result = JSON.parse(rawText);
    } catch (parseError) {
      console.error("❌ Could not parse Gemini JSON response");
      throw new Error("Invalid JSON returned by Gemini");
    }

    // Basic validation before returning the result.
    if (typeof result.understood !== "boolean") {
      throw new Error("Gemini returned an invalid understood value");
    }

    if (
      result.quantity !== null &&
      (
        typeof result.quantity !== "number" ||
        !Number.isFinite(result.quantity) ||
        result.quantity <= 0
      )
    ) {
      result.quantity = null;
    }

    if (result.size !== null && typeof result.size !== "string") {
      result.size = null;
    }

    if (
      result.product_query !== null &&
      typeof result.product_query !== "string"
    ) {
      result.product_query = null;
    }

    console.log("✅ Gemini voice understanding completed");
    console.log("📋 Voice result:", {
      product_query: result.product_query,
      size: result.size,
      quantity: result.quantity,
      understood: result.understood
    });

    return result;

  } catch (error) {
    console.error("❌ Gemini voice processing failed:", error.message);

    return {
      product_query: null,
      size: null,
      quantity: null,
      understood: false
    };
  }
}

module.exports = {
  understandVoiceOrder
};