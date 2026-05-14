const express = require("express");
const twilio = require("twilio");
const { generateSmsReply } = require("../services/sms");

module.exports = (knowledgeBase) => {
  const router = express.Router();

  router.post("/sms", async (req, res) => {
    try {
      const from = req.body.From;
      const incomingMessage = req.body.Body;

      console.log("SMS reçu de:", from);
      console.log("Message:", incomingMessage);

      const reply = await generateSmsReply(
        incomingMessage,
        knowledgeBase
      );

      const twiml = new twilio.twiml.MessagingResponse();

      twiml.message(reply);

      res.type("text/xml").send(twiml.toString());

    } catch (err) {
      console.error("SMS ERROR:", err);

      res.type("text/xml").send(`
<Response>
  <Message>
    Désolé, une erreur est survenue.
  </Message>
</Response>
      `);
    }
  });

  return router;
};
