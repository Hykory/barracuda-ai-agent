const express = require("express");
const router = express.Router();

router.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Gather numDigits="1" action="/voice/language" method="POST" timeout="5">
    <Say language="fr-CA" voice="Polly.Chantal" >Pour le français, appuyez sur 1.</Say>
    <Say language="en-US" voice="Polly.Joanna" >For English, press 2.</Say>
  </Gather>
  <Redirect method="POST">/voice/language?Digits=1</Redirect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

router.post("/voice/language", (req, res) => {
  const digit = req.body.Digits || req.query.Digits || "1";
  const lang = digit === "2" ? "en" : "fr";

  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://barracuda-ai-agent-production-806d.up.railway.app/ws">
      <Parameter name="language" value="${lang}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

module.exports = router;