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

// ✅ Send message via Twilio REST API directly
async function sendWhatsAppMessage(to, messageBody) {
  try {
    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: messageBody
    });
    console.log("✅ Message sent via REST API — SID:", message.sid);
    return true;
  } catch (err) {
    console.error("❌ REST API send error:", err.message);
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
    `💬 Reply *ADD* to add to cart\n` +
    `🛒 Reply *CART* to view your cart`
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

// ✅ Safe session save
async function saveSession(phone, data) {
  try {
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    let saveError;

    if (existing) {
      const { error } = await supabase
        .from("user_sessions")
        .update({ last_results: data })
        .eq("phone_number", phone);
      saveError = error;
      console.log("🔄 Session updated for:", phone);
    } else {
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

    const { data: verify } = await supabase
      .from("user_sessions")
      .select("last_results")
      .eq("phone_number", phone)
      .maybeSingle();

    if (verify && verify.last_results) {
      console.log(`✅ Session verified — ${verify.last_results.length} products saved`);
      return true;
    } else {
      console.error("❌ Session verification failed");
      return false;
    }

  } catch (err) {
    console.error("❌ Session save exception:", err.message);
    return false;
  }
}

// ✅ Save selected product ID to session
async function saveSelectedProduct(phone, productId) {
  try {
    // ✅ First check session exists
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    let error;

    if (existing) {
      // ✅ Update existing session
      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({ selected_product_id: productId })
        .eq("phone_number", phone);
      error = updateError;
    } else {
      // ✅ Create new session with product id
      const { error: insertError } = await supabase
        .from("user_sessions")
        .insert({
          phone_number: phone,
          selected_product_id: productId
        });
      error = insertError;
    }

    if (error) {
      console.error("❌ Failed to save selected_product_id:", error.message);
      return false;
    }

    // ✅ Verify it was saved
    const { data: verify } = await supabase
      .from("user_sessions")
      .select("selected_product_id")
      .eq("phone_number", phone)
      .maybeSingle();

    console.log("🔎 selected_product_id verification:", verify?.selected_product_id || "NOT SAVED ❌");
    return true;

  } catch (err) {
    console.error("❌ saveSelectedProduct exception:", err.message);
    return false;
  }
}

// ✅ TwiML response helper
function sendTwiml(res, twiml) {
  const xml = twiml.toString();
  console.log("📤 Final TwiML:", xml);
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(xml);
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
    const msgUpper = msg.toUpperCase();

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

    // ✅ Fetch full session at top
    const { data: session, error: sessionFetchError } = await supabase
      .from("user_sessions")
      .select("*")
      .eq("phone_number", phone)
      .maybeSingle();

    console.log("📋 Full session:", JSON.stringify(session, null, 2));
    console.log("❗ Session fetch error:", sessionFetchError ? sessionFetchError.message : "none");

    // ✅ 1. GREETING FIRST
    if (GREETINGS.includes(msgLower)) {
      console.log("👋 Greeting received — sending via REST API");
      res.status(200).end();
      await sendWhatsAppMessage(
        phone,
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
      return;
    }

    // ✅ 2. CHECKOUT STEP — NAME
    if (session?.checkout_step === "name") {
      console.log("📝 Collecting customer name:", msg);

      const { error: updateError } = await supabase
        .from("user_sessions")
        .update({ customer_name: msg, checkout_step: "address" })
        .eq("phone_number", phone);

      if (updateError) {
        twiml.message(`⚠️ Something went wrong. Please type your name again.`);
        return sendTwiml(res, twiml);
      }

      console.log(`✅ Name saved: ${msg}`);
      twiml.message(`✅ Name saved: *${msg}*\n\n📍 Please enter your delivery address:`);
      return sendTwiml(res, twiml);
    }

    // ✅ 3. CHECKOUT STEP — ADDRESS
    if (session?.checkout_step === "address") {
      console.log("📍 Collecting address:", msg);

      const { data: cartItems } = await supabase
        .from("cart")
        .select("*")
        .eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: null })
          .eq("phone_number", phone);

        twiml.message(`⚠️ Your cart is empty. Please add products first!`);
        return sendTwiml(res, twiml);
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert({
          phone_number: phone,
          customer_name: session.customer_name,
          customer_address: msg,
          status: "pending"
        })
        .select()
        .single();

      if (orderError || !order) {
        console.error("❌ Order error:", orderError?.message);
        twiml.message(`⚠️ Could not place order. Please try again!`);
        return sendTwiml(res, twiml);
      }

      let orderTotal = 0;
      let orderSummary = "";

      for (const item of cartItems) {
        const { data: product } = await supabase
          .from("products")
          .select("*")
          .eq("id", item.product_id)
          .maybeSingle();

        if (product) {
          await supabase.from("order_items").insert({
            order_id: order.id,
            product_id: item.product_id,
            quantity: item.quantity
          });

          const itemTotal = product.price * item.quantity;
          orderTotal += itemTotal;
          orderSummary += `• ${product.product_name} × ${item.quantity} = ₹${itemTotal}\n`;
        }
      }

      await supabase.from("cart").delete().eq("phone_number", phone);
      await supabase
        .from("user_sessions")
        .update({ checkout_step: null, customer_address: msg })
        .eq("phone_number", phone);

      console.log(`✅ Order placed — Total: ₹${orderTotal}`);

      twiml.message(
        `✅ *Order Placed Successfully!*\n\n` +
        `🧾 *Order Summary:*\n${orderSummary}\n` +
        `💰 *Total: ₹${orderTotal}*\n\n` +
        `👤 Name: ${session.customer_name}\n` +
        `📍 Address: ${msg}\n\n` +
        `🆔 Order ID: ${order.id}\n\n` +
        `Thank you for shopping with *StyleFlow*! 🎉`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 4. CHECKOUT COMMAND
    if (msgUpper === "CHECKOUT") {
      console.log("🛒 CHECKOUT command");

      const { data: cartCheck } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartCheck || cartCheck.length === 0) {
        twiml.message(`⚠️ Your cart is empty!\n\nSearch for products and type *ADD* first.`);
        return sendTwiml(res, twiml);
      }

      await supabase
        .from("user_sessions")
        .update({ checkout_step: "name" })
        .eq("phone_number", phone);

      twiml.message(
        `🛍️ *Checkout*\n\n` +
        `${cartCheck.length} item${cartCheck.length > 1 ? "s" : ""} in your cart.\n\n` +
        `👤 Please enter your *full name*:`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 5. ADD COMMAND — fully debugged
    if (msgUpper === "ADD") {
      console.log("🛒 ADD command received");
      console.log("📋 Session at ADD time:", JSON.stringify(session, null, 2));
      console.log("🔑 selected_product_id:", session?.selected_product_id || "MISSING ❌");

      if (!session?.selected_product_id) {
        twiml.message(
          `⚠️ Please select a product first.\n\n` +
          `Search for a product, select a number, then type *ADD*`
        );
        return sendTwiml(res, twiml);
      }

      console.log(`🔍 Fetching product: ${session.selected_product_id}`);

      const { data: product, error: productError } = await supabase
        .from("products")
        .select("*")
        .eq("id", session.selected_product_id)
        .maybeSingle();

      console.log("📦 Product fetched:", product?.product_name || "NOT FOUND ❌");
      console.log("❗ Product error:", productError ? productError.message : "none");

      if (productError || !product) {
        twiml.message(`⚠️ Product not found. Please search and select again!`);
        return sendTwiml(res, twiml);
      }

      // ✅ Check if already in cart
      const { data: existingCart } = await supabase
        .from("cart")
        .select("*")
        .eq("phone_number", phone)
        .eq("product_id", session.selected_product_id)
        .maybeSingle();

      console.log("🛒 Existing cart item:", existingCart ? `found — qty ${existingCart.quantity}` : "none");

      if (existingCart) {
        const { error: updateError } = await supabase
          .from("cart")
          .update({ quantity: existingCart.quantity + 1 })
          .eq("id", existingCart.id);

        if (updateError) {
          console.error("❌ Cart update error:", updateError.message);
          twiml.message(`⚠️ Could not update cart. Please try again!`);
          return sendTwiml(res, twiml);
        }

        console.log(`✅ Quantity updated — ${product.product_name} x${existingCart.quantity + 1}`);
        twiml.message(
          `✅ *Cart Updated!*\n\n` +
          `📦 ${product.product_name}\n` +
          `💰 ₹${product.price}\n` +
          `🔢 Quantity: ${existingCart.quantity + 1}\n\n` +
          `🛒 Type *CART* to view\n` +
          `✅ Type *CHECKOUT* to order`
        );

      } else {
        const { error: cartError } = await supabase
          .from("cart")
          .insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1
          });

        console.log("❗ Cart insert error:", cartError ? cartError.message : "none");

        if (cartError) {
          console.error("❌ Cart insert error:", cartError.message);
          twiml.message(`⚠️ Could not add to cart. Please try again!`);
          return sendTwiml(res, twiml);
        }

        console.log(`✅ Added to cart — ${product.product_name}`);
        twiml.message(
          `✅ *Added to Cart!*\n\n` +
          `📦 ${product.product_name}\n` +
          `💰 ₹${product.price}\n\n` +
          `🛒 Type *CART* to view\n` +
          `✅ Type *CHECKOUT* to order`
        );
      }

      return sendTwiml(res, twiml);
    }

    // ✅ 6. CART COMMAND
    if (msgUpper === "CART") {
      console.log("🛒 CART command");

      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        twiml.message(
          `🛒 Your cart is empty.\n\n` +
          `Search for products!\nExample: Type *Black* or *Jeans*`
        );
        return sendTwiml(res, twiml);
      }

      let reply = `🛒 *Your Cart*\n\n`;
      let total = 0;
      let itemCount = 0;

      for (let i = 0; i < cartItems.length; i++) {
        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", cartItems[i].product_id).maybeSingle();

        if (product) {
          const itemTotal = product.price * cartItems[i].quantity;
          total += itemTotal;
          itemCount++;
          reply += `${i + 1}. *${product.product_name}*\n`;
          reply += `   💰 ₹${product.price} × ${cartItems[i].quantity} = ₹${itemTotal}\n`;
          reply += `   📐 Size: ${product.size} | 🎨 Color: ${product.color}\n\n`;
        }
      }

      reply += `─────────────────\n`;
      reply += `🧾 *Total: ₹${total}*\n`;
      reply += `📦 ${itemCount} item${itemCount > 1 ? "s" : ""} in cart\n\n`;
      reply += `✅ Type *CHECKOUT* to place order\n`;
      reply += `🔍 Or search for more products!`;

      twiml.message(reply);
      return sendTwiml(res, twiml);
    }

    // ✅ 7. NUMBER CHECK
    const isNumber = /^[0-9]+$/.test(msg);

    if (isNumber) {
      console.log(`🔢 Number: ${msg}`);
      const index = parseInt(msg) - 1;

      if (!session || !session.last_results) {
        twiml.message(`⚠️ Session expired. Please search again!`);
        return sendTwiml(res, twiml);
      }

      session.last_results.forEach((p, i) => console.log(`   ${i + 1}. ${p.product_name}`));
      console.log(`🎯 Selected index ${index} → ${session.last_results[index]?.product_name}`);

      const sessionProduct = session.last_results[index];

      if (!sessionProduct) {
        twiml.message(`⚠️ Invalid selection. Choose between *1* and *${session.last_results.length}*`);
        return sendTwiml(res, twiml);
      }

      const { data: freshProduct, error: fetchError } = await supabase
        .from("products").select("*")
        .eq("product_name", sessionProduct.product_name).maybeSingle();

      if (fetchError || !freshProduct) {
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      console.log(`✅ Saving selected_product_id: ${freshProduct.id}`);
      await saveSelectedProduct(phone, freshProduct.id);

      // ✅ Verify immediately after saving
      const { data: verifySession } = await supabase
        .from("user_sessions")
        .select("selected_product_id")
        .eq("phone_number", phone)
        .maybeSingle();

      console.log("🔎 Verified selected_product_id in DB:", verifySession?.selected_product_id || "NOT FOUND ❌");

      await sendProductMessage(twiml, freshProduct);
      return sendTwiml(res, twiml);
    }

    // ✅ 8. SEARCH LAST
    console.log(`🔍 Searching: "${msg}"`);

    const { data, error } = await supabase
      .from("products").select("*")
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`);

    console.log("📊 Found:", data ? data.length : 0);

    if (data && data.length > 0) {

      await saveSession(phone, data);

      if (data.length === 1) {
        await saveSelectedProduct(phone, data[0].id);
        await sendProductMessage(twiml, data[0]);

      } else {
        let response = `🛍️ *StyleFlow* — Products matching "${msg}":\n\n`;
        data.forEach((product, index) => {
          response += `${index + 1}. *${product.product_name}*\n`;
          response += `   💰 ₹${product.price}\n`;
          response += `   📦 Stock: ${product.stock}\n`;
          response += `   📐 Size: ${product.size}\n`;
          response += `   🎨 Color: ${product.color}\n`;
          response += product.image_url ? `   🖼️ Image available\n\n` : `\n`;
        });
        response += `_Reply with a number to see details + image!_`;
        twiml.message(response);
      }

    } else {
      twiml.message(
        `Sorry, no product found for "${msg}". 😔\n\n` +
        `Try: *Black*, *Jeans*, *XL*`
      );
    }

    return sendTwiml(res, twiml);

  } catch (error) {
    console.error("❌ Error:", error.message);
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

// 5. 404 handler
app.use((req, res) => {
  console.log(`⚠️ Unknown route: ${req.method} ${req.url}`);
  res.status(404).send("Route not found");
});

// 6. Error handler
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});