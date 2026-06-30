// ✅ Centralized WhatsApp message templates

function orderConfirmed(shopName, orderNum) {
  return (
    `✅ *Your order has been confirmed!*\n\n` +
    `🆔 Order #${orderNum}\n\n` +
    `We're preparing your order.\n\n` +
    `Thank you for shopping with *${shopName}*! 🛍️`
  );
}

function orderDelivered(shopName, orderNum) {
  return (
    `🎉 *Your order has been delivered!*\n\n` +
    `🆔 Order #${orderNum}\n\n` +
    `Thank you for shopping with *${shopName}*!\n\n` +
    `We'd love to serve you again. 😊`
  );
}

function orderCancelled(shopName, orderNum) {
  return (
    `❌ *Your order has been cancelled.*\n\n` +
    `🆔 Order #${orderNum}\n\n` +
    `If you have any questions please contact us.\n\n` +
    `Thank you for shopping with *${shopName}*!`
  );
}

function orderPlaced(shopName, customerName, orderSummary, orderTotal, fullAddress, storeOrderNumber, formattedDate) {
  return (
    `✅ *Order Placed Successfully!*\n\n` +
    `🧾 *Order Summary:*\n${orderSummary}\n` +
    `💰 *Total: ₹${orderTotal}*\n\n` +
    `👤 Name: ${customerName}\n` +
    `📍 Address: ${fullAddress}\n\n` +
    `🆔 Order #${storeOrderNumber}\n` +
    `🕐 ${formattedDate}\n\n` +
    `📦 Type *ORDER STATUS* to track your order\n\n` +
    `Thank you for shopping with *${shopName}*! 🎉`
  );
}

function offerMessage(shopName, title, description, couponCode) {
  let msg =
    `🎁 *Special Offer from ${shopName}!*\n\n` +
    `*${title}*\n\n` +
    `${description}\n`;

  if (couponCode) {
    msg += `\n🏷️ Use coupon code: *${couponCode}*\n`;
  }

  msg += `\n🛍️ Shop now — just type a product name!\n`;
  msg += `Happy Shopping! 🎉`;

  return msg;
}

module.exports = {
  orderConfirmed,
  orderDelivered,
  orderCancelled,
  orderPlaced,
  offerMessage,
};