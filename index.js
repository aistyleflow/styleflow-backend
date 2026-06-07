const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ✅ Greeting keywords
const GREETINGS = ["hi", "hello", "hey", "helo", "hii", "start", "namaste"];

// 1. Home route
app.get("/", (req, res) => {
  res.send("StyleFlow is running!");
});

// 2. WhatsApp webhook verification (GET)
app.get("/whatsapp", (req, res) => {
  console.log("Someone accessed WhatsApp endpoint");

  const VERIFY_TOKEN = "styleflow_token";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta!");
    res.status(200).send(challenge);
  } else {
    res.status(200).send("WhatsApp webhook is active!");
  }
});

// ✅ Check if image URL is publicly accessible
async function isImageAccessible(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    console.log(`🔎 Image URL check: ${url} → status ${response.status}`);
    return response.ok;
  } catch (err) {
    console.error("❌ Image URL not accessible:", err.message);
    return false;
  }
}

// ✅ Reusable function — sends product details + image
async function sendProductMessage(twiml, product) {
  console.log("FULL PRODUCT OBJECT:", JSON.stringify(product, null, 2));
  console.log("Selected image:", product.image_url || "NONE");

  const message = twiml.message();

  message.body(
    `🛍️ *Product Details*\n\n` +
    `📦 Product: ${product.product_name}\n` +
    `💰 Price: ₹${product.price}\n` +
    `📦 Stock: ${product.stock}\n` +
    `📐 Size: ${product.size}\n` +
    `🎨 Color: ${product.color}\n\n` +
    `_Search another keyword to find more products!_`
  );

  if (product.image_url) {
    const accessible = await isImageAccessible(product.image_url);
    if (accessible) {
      console.log("About to send media:", product.image_url);
      message.media(product.image_url);
      console.log("✅ Media attached successfully");
    } else {
      console.log("❌ Image not publicly accessible");
    }
  } else {
    console.log("⚠️ No image URL — skipping media");
  }
}

// ✅ Safe session save — guaranteed to work
async function saveSession(phone, data) {
  try {
    // ✅ Check if session exists first
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    let saveError;

    if (existing) {
      // ✅ Session exists — UPDATE only last_results
      const { error } = await supabase
        .from("user_sessions")
        .update({ last_results: data })
        .eq("phone_number", phone);
      saveError = error;
      console.log("🔄 Session updated for:", phone);
    } else {
      // ✅ No session — INSERT fresh
      const { error } = await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, last_results: data });
      saveError = error;
      console.log("🆕 Session created for:", phone);
    }

    if (saveError) {
      console.error("❌ Session save error:", saveError.message);
      return false;
    }

    // ✅ Verify session was saved correctly
    const { data: verify } = await supabase
      .from("user_sessions")
      .select("last_results")
      .eq("phone_number", phone)
      .maybeSingle();

    if (verify && verify.last_results) {
      console.log(`✅ Session verified — ${verify.last_results.length} products saved`);
      verify.last_results.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.product_name}`);
      });
      return true;
    } else {
      console.error("❌ Session verification failed — data not found after save");
      return false;
    }

  } catch (err) {
    console.error("❌ Session save exception:", err.message);
    return false;
  }
}

// 3. WhatsApp incoming messages (POST)
app.post("/whatsapp", async (req, res) => {
  try {
    const body = req.body;

    if (!body) {
      console.log("⚠️ Empty request received");
      return res.status(400).end();
    }

    const phone = body.From;
    const msg = body.Body ? body.Body.trim() : "";
    const msgLower = msg.toLowerCase();

    console.log("=================================");
    console.log("📩 New message received");
    console.log("PHONE RAW VALUE:", phone);
    console.log("MESSAGE:", msg);
    console.log("=================================");

    if (!phone || !msg) {
      console.log("⚠️ Missing phone or message");
      return res.status(400).end();
    }

    const twiml = new twilio.twiml.MessagingResponse();

    // ✅ 1. GREETING CHECK FIRST
    if (GREETINGS.includes(msgLower)) {
      console.log("👋 Greeting received");

      // ✅ Safe delete — only clear last_results, keep the row
      await supabase
        .from("user_sessions")
        .update({ last_results: null })
        .eq("phone_number", phone);

      console.log("🗑️ Session cleared for:", phone);

      twiml.message(
        `👋 Welcome to *StyleFlow*! 🛍️\n\n` +
        `We are your personal fashion assistant.\n\n` +
        `🔍 *How to shop:*\n` +
        `Just type what you are looking for!\n\n` +
        `Examples:\n` +
        `• Type *Black* to see black products\n` +
        `• Type *Jeans* to see all jeans\n` +
        `• Type *XL* to see XL size items\n\n` +
        `Happy Shopping! 🎉`
      );

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(twiml.toString());
    }

    // ✅ 2. NUMBER CHECK SECOND
    const isNumber = /^[0-9]+$/.test(msg);

    if (isNumber) {
      console.log(`🔢 Number received: ${msg}`);
      const index = parseInt(msg) - 1;

      const { data: session, error: sessionError } = await supabase
        .from("user_sessions")
        .select("*")
        .eq("phone_number", phone)
        .limit(1)
        .maybeSingle();

      console.log("🔍 Session lookup for:", phone);
      console.log("❗ Session error:", sessionError ? sessionError.message : "none");

      if (sessionError) {
        twiml.message(`⚠️ Something went wrong. Please search again!\n\nExample: type *Black* or *Jeans*`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      if (!session || !session.last_results) {
        twiml.message(`⚠️ Session expired. Please search again!\n\nExample: type *Black* or *Jeans*`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      // ✅ Log exact order to verify
      console.log("📦 Products in session (in order):");
      session.last_results.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.product_name}`);
      });
      console.log(`🎯 Selected: ${msg} → index ${index} → ${session.last_results[index]?.product_name}`);

      const sessionProduct = session.last_results[index];

      if (!sessionProduct) {
        const max = session.last_results.length;
        twiml.message(`⚠️ Invalid selection.\n\nPlease choose a number between *1* and *${max}*`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      // ✅ Re-fetch fresh product from products table
      const { data: freshProduct, error: fetchError } = await supabase
        .from("products")
        .select("*")
        .eq("product_name", sessionProduct.product_name)
        .maybeSingle();

      console.log("🔄 Fresh product fetched:", freshProduct?.product_name);
      console.log("❗ Fetch error:", fetchError ? fetchError.message : "none");

      if (fetchError || !freshProduct) {
        twiml.message(`⚠️ Product not found. Please search again!`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      await sendProductMessage(twiml, freshProduct);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(twiml.toString());
    }

    // ✅ 3. SEARCH LOGIC THIRD
    console.log(`🔍 Searching products for: "${msg}"`);

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`);

    console.log("📊 Products found:", data ? data.length : 0);
    console.log("❗ Search error:", error ? error.message : "none");

    if (data && data.length > 0) {

      // ✅ Use safe session save function — no more empty sessions
      const saved = await saveSession(phone, data);

      if (!saved) {
        console.error("❌ Session could not be saved — number selection may not work");
      }

      // ✅ Single result — send directly with image
      if (data.length === 1) {
        console.log("✅ Single product — sending directly");
        await sendProductMessage(twiml, data[0]);

      } else {
        // ✅ Multiple results — numbered list
        let response = `🛍️ *StyleFlow* — Products matching "${msg}":\n\n`;

        data.forEach((product, index) => {
          response += `${index + 1}. *${product.product_name}*\n`;
          response += `   💰 ₹${product.price}\n`;
          response += `   📦 Stock: ${product.stock}\n`;
          response += `   📐 Size: ${product.size}\n`;
          response += `   🎨 Color: ${product.color}\n`;
          response += product.image_url ? `   🖼️ Image available\n\n` : `\n`;
        });

        response += `_Reply with a number (1, 2, 3...) to see full details + image!_`;
        twiml.message(response);
      }

    } else {
      console.log("⚠️ No product found for:", msg);
      twiml.message(
        `Sorry, we couldn't find any product matching "${msg}". 😔\n\n` +
        `Try a different keyword!\n` +
        `Example: *Black*, *Jeans*, *XL*`
      );
    }

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

  } catch (error) {
    console.error("❌ Error handling message:", error.message);
    res.status(500).end();
  }
});

// 4. Products route
app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase.from("products").select("*");

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(200).json({ message: "No products found" });

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// 5. 404 handler - ALWAYS LAST
app.use((req, res) => {
  console.log(`⚠️ Unknown route: ${req.method} ${req.url}`);
  res.status(404).send("Route not found");
});

// 6. Error handling - ALWAYS LAST
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});