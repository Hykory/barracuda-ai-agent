
function createTransferService(twilioClient, humanPhoneNumber) {
  return async function transferCallToHuman(callSid) {
    if (!callSid) {
      console.error("Impossible de transférer : callSid manquant.");
      return {
        success: false,
        message: "Impossible de transférer l’appel pour le moment.",
      };
    }

    const twiml = `
<Response>
  <Say language="fr-CA">
    Je vais vous transférer à quelqu’un de l’équipe. Un instant s’il vous plaît.
  </Say>

  <Dial>${humanPhoneNumber}</Dial>
</Response>`;

    await twilioClient.calls(callSid).update({ twiml });

    return {
      success: true,
      message: "Transfert en cours.",
    };
  };
}

module.exports = { createTransferService };
