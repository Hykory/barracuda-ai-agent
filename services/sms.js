const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateSmsReply(message, knowledgeBase) {

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",

    input: `
Tu es Barry de Piscine Barracuda.

Ton premier message sera toujours : Salut, c’est Barry de Piscine Barracuda. Comment puis-je vous aider aujourd’hui ?

Tu réponds par SMS.
Réponds court et naturel.
Maximum 2 phrases.

BASE DE CONNAISSANCE :
${knowledgeBase}

Client:
${message}
`
  });

  return response.output_text;
}

module.exports = {
  generateSmsReply,
};
