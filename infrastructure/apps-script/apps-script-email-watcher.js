/**
 * Gmail → Mission Control Email Lead Capture
 * 
 * SETUP (do this for EACH account: ryansvg@lrghomes.com & ryansvj@lrghomes.com):
 * 
 * 1. Log into the Gmail account
 * 2. Go to https://script.google.com
 * 3. Click "New Project"
 * 4. Delete the default code and paste this entire file
 * 5. Change MAILBOX below to match the account you're logged into
 * 6. Click the floppy disk / Ctrl+S to save
 * 7. Click Run → select "checkForNewLeads" → Run
 *    (It will ask for Gmail permissions — approve them)
 * 8. Click the clock icon (Triggers) on the left sidebar
 * 9. Click "+ Add Trigger"
 *    - Function: checkForNewLeads
 *    - Event source: Time-driven
 *    - Type: Minutes timer
 *    - Interval: Every 1 minute
 *    - Save
 * 
 * That's it. The script checks every minute for new unread emails and
 * forwards them to Mission Control.
 */

// ═══════════════════════════════════════════════════════════════════════
// CHANGE THIS to match the account:
//   "ryansvg@lrghomes.com" for Campaign A (pink envelope)
//   "ryansvj@lrghomes.com" for Campaign B (white envelope)
const MAILBOX = "ryansvg@lrghomes.com";
// ═══════════════════════════════════════════════════════════════════════

const WEBHOOK_URL = "https://mission-control-three-chi.vercel.app/api/leads/email";
const SECRET = "f4643bf781596d4184105e4017650745a8cfa7f7c660bad1";

function checkForNewLeads() {
  // Search for unread emails in inbox
  var threads = GmailApp.search("is:unread in:inbox", 0, 10);
  
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      if (msg.isUnread()) {
        var from = msg.getFrom();
        var subject = msg.getSubject();
        var body = msg.getPlainBody().substring(0, 3000); // cap at 3k chars
        var date = msg.getDate().toISOString();
        
        var payload = {
          secret: SECRET,
          mailbox: MAILBOX,
          from: from,
          subject: subject,
          body: body,
          date: date
        };
        
        var options = {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        };
        
        try {
          var response = UrlFetchApp.fetch(WEBHOOK_URL, options);
          var code = response.getResponseCode();
          if (code === 200) {
            msg.markRead(); // Only mark read on success
            Logger.log("✓ Forwarded: " + subject + " from " + from);
          } else {
            Logger.log("✗ Webhook returned " + code + ": " + response.getContentText());
          }
        } catch (e) {
          Logger.log("✗ Error sending to webhook: " + e.message);
          // Don't mark read — will retry next minute
        }
      }
    }
  }
}
