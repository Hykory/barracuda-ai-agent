const express = require("express");

module.exports = (knowledgeBase) => {
  const router = express.Router();

  router.post("/sms", (req, res) => {
    console.log("SMS ROUTE WORKS");
    console.log("BODY:", req.body);

    res.type("text/xml").send(`
<Response>
  <Message>SMS OK</Message>
</Response>
    `);
  });

  return router;
};