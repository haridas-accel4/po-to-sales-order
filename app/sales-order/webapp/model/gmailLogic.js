/**
 * Pure display logic for the Gmail settings dialog and Gmail-sourced orders.
 * No UI5 dependencies, so it is unit-tested in Node (test/unit/gmail-logic.test.js).
 */
sap.ui.define([], function () {
    "use strict";

    const SOURCE_TEXT = { UPLOAD: "Manual Upload", EMAIL: "Gmail" };

    function sourceText(source) {
        return SOURCE_TEXT[source] || source || "";
    }

    /**
     * @param {object} status result of gmailStatus()
     * @param {function(string):string} formatDateTime ISO timestamp -> display text
     */
    function statusView(status, formatDateTime) {
        const s = status || {};
        const fmt = function (value) { return value ? formatDateTime(value) : "Never"; };
        let connection;
        if (!s.configured) {
            connection = { text: "Not configured", state: "Warning", icon: "sap-icon://alert" };
        } else if (!s.connected) {
            connection = { text: "Not connected", state: "None", icon: "sap-icon://disconnected" };
        } else if (s.lastError && /authori[sz]ation/i.test(s.lastError)) {
            connection = { text: "Reconnect required", state: "Error", icon: "sap-icon://error" };
        } else {
            connection = { text: "Connected", state: "Success", icon: "sap-icon://connected" };
        }

        let polling;
        if (!s.autoPollEnabled) {
            polling = "Off (GMAIL_AUTO_POLL_ENABLED=false)";
        } else if (!s.connected) {
            polling = "Starts after connecting (every " + s.pollIntervalMinutes + " min)";
        } else {
            polling = "On, every " + s.pollIntervalMinutes + " min" + (s.nextPollAt ? " (next: " + formatDateTime(s.nextPollAt) + ")" : "");
        }

        return {
            configured: !!s.configured,
            connected: !!s.connected,
            canConnect: !!s.configured && !s.connected,
            canReconnect: !!s.configured && !!s.connected,
            canDisconnect: !!s.connected,
            canCheck: !!s.connected && !s.polling,
            connectionText: connection.text,
            connectionState: connection.state,
            connectionIcon: connection.icon,
            emailAddress: s.emailAddress || "–",
            pollingText: s.polling ? "Checking now…" : polling,
            lastCheckedText: fmt(s.lastCheckedAt),
            lastSuccessText: fmt(s.lastSuccessAt),
            emailsChecked: s.emailsChecked || 0,
            attachmentsProcessed: s.attachmentsProcessed || 0,
            attachmentsFailed: s.attachmentsFailed || 0,
            keywords: s.keywords || "",
            lastError: s.lastError || "",
            notConfiguredHint: s.configured ? "" :
                "Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in the server's .env file and restart the server (see docs/gmail-setup.md)."
        };
    }

    /** Message for the result of checkGmailNow(). */
    function syncSummary(r) {
        if (!r) {
            return "";
        }
        const parts = [
            r.messagesChecked + " new email(s) checked",
            r.attachmentsProcessed + " attachment(s) processed"
        ];
        if (r.messagesIgnored) {
            parts.push(r.messagesIgnored + " email(s) ignored (no PO keyword or no supported attachment)");
        }
        if (r.attachmentsRejected) {
            parts.push(r.attachmentsRejected + " attachment(s) rejected by file validation");
        }
        if (r.attachmentsFailed) {
            parts.push(r.attachmentsFailed + " attachment(s) failed and will be retried");
        }
        let text = parts.join(", ") + ".";
        if (r.complete === false) {
            text += " More emails are waiting and will be processed on the next check.";
        }
        return text;
    }

    /** Gmail origin of an inbound order ($expand=emailAttachment($expand=message)) or null. */
    function emailOrigin(order, formatDateTime) {
        const att = order && order.emailAttachment;
        if (!att) {
            return null;
        }
        const msg = att.message || {};
        return {
            sender: msg.sender || "–",
            subject: msg.subject || "(no subject)",
            fileName: att.fileName || order.fileName || "",
            receivedAt: msg.receivedAt ? formatDateTime(msg.receivedAt) : "–"
        };
    }

    return {
        sourceText: sourceText,
        statusView: statusView,
        syncSummary: syncSummary,
        emailOrigin: emailOrigin
    };
});
