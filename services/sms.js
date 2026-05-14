const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateSmsReply(
  message,
  knowledgeBase,
  mediaUrl,
  isFirstMessage
) {

  const input = [];

  input.push({
    role: "system",
    content: [
      {
        type: "input_text",
        text: `
Tu es Barry de Piscine Barracuda.

${
  isFirstMessage
    ? "Presente-toi UNE SEULE FOIS au debut de la conversation."
    : "Ne te presente jamais de nouveau. Reponds directement."
}

STYLE SMS :
- Reponses courtes
- Naturel
- Maximum 2 phrases
- Ton humain et amical
- Pas de longs paragraphes

BASE DE CONNAISSANCE :
${knowledgeBase}
`
      }
    ]
  });

  if (message) {
    input.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text: message,
        }
      ]
    });
  }

  if (mediaUrl) {
    input.push({
      role: "user",
      content: [
        {
          type: "input_image",
          image_url: mediaUrl,
        }
      ]
    });
  }

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input,
  });

  return response.output_text;
}

module.exports = {
  generateSmsReply,
};