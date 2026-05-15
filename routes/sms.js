const express = require("express");
const twilio = require("twilio");
const { generateSmsReply } = require("../services/sms");
const fs = require("fs");
const path = require("path");

module.exports = (knowledgeBase) => {
  const router = express.Router();

  router.post("/sms", async (req, res) => {
    try {
      const from = req.body.From;
      const incomingMessage = req.body.Body;
      const mediaUrl = req.body.MediaUrl0 || null;

      const memoryPath = path.join(__dirname, "../sms-memory");

      if (!fs.existsSync(memoryPath)) {
        fs.mkdirSync(memoryPath);
      }

      const userFile = path.join(memoryPath, `${from}.json`);

      let isFirstMessage = false;

      if (!fs.existsSync(userFile)) {
        isFirstMessage = true;

        fs.writeFileSync(
          userFile,
          JSON.stringify({
            startedAt: new Date().toISOString(),
          })
        );
      }

      console.log("SMS recu de:", from);
      console.log("Message:", incomingMessage);
      console.log("Image:", mediaUrl);
      console.log("FINAL isFirstMessage:", isFirstMessage);

      const reply = await generateSmsReply(
        incomingMessage,
        knowledgeBase,
        mediaUrl,
        isFirstMessage
      );

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);

      res.type("text/xml").send(twiml.toString());
    } catch (err) {
      console.error("SMS ERROR:", err);

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("Desole, une erreur est survenue.");

      res.type("text/xml").send(twiml.toString());
    }
  });

  return router;
};