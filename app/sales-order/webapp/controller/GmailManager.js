sap.ui.define([
    "sap/ui/base/Object",
    "sap/ui/core/Fragment",
    "sap/ui/core/format/DateFormat",
    "sap/ui/model/json/JSONModel",
    "sap/ui/Device",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "po2so/salesorder/model/gmailLogic"
], function (BaseObject, Fragment, DateFormat, JSONModel, Device, MessageToast, MessageBox, gmailLogic) {
    "use strict";

    const dateTimeFormat = DateFormat.getDateTimeInstance({ style: "medium" });
    const formatDateTime = function (iso) { return dateTimeFormat.format(new Date(iso)); };

    async function request(url, options) {
        const response = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json", Accept: "application/json" } }, options));
        const text = await response.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { error: { message: text && text.length < 300 ? text : "HTTP " + response.status } };
        }
        return { ok: response.ok, status: response.status, body: body };
    }

    function errorMessage(result) {
        return (result.body && result.body.error && result.body.error.message) || ("Request failed with HTTP " + result.status + ".");
    }

    /**
     * Gmail settings dialog: connection status, connect / disconnect, "Check Gmail Now".
     * OAuth runs as a full-page redirect to /auth/gmail/connect; tokens never reach the browser.
     */
    return BaseObject.extend("po2so.salesorder.controller.GmailManager", {

        /**
         * @param {sap.ui.core.mvc.View} view
         * @param {string} serviceUrl OData service root (with trailing slash)
         * @param {{onChanged:function}} hooks onChanged is called after new orders may have arrived
         */
        constructor: function (view, serviceUrl, hooks) {
            BaseObject.call(this);
            this._view = view;
            this._serviceUrl = serviceUrl;
            this._hooks = hooks || {};
            this._model = new JSONModel({ status: null, view: gmailLogic.statusView(null, formatDateTime), problems: [] });
            view.setModel(this._model, "gmail");
        },

        open: async function () {
            if (!this._dialog) {
                this._dialog = await Fragment.load({ id: this._view.getId(), name: "po2so.salesorder.view.GmailSettings", controller: this });
                this._dialog.setStretch(Device.system.phone);
                this._view.addDependent(this._dialog);
            }
            this._dialog.open();
            await this.load();
        },

        /** Reload status and the latest problem attachments. */
        load: async function () {
            const dialog = this._dialog && this._dialog.isOpen() ? this._dialog : null;
            if (dialog) {
                dialog.setBusy(true);
            }
            try {
                const [status, problems] = await Promise.all([
                    request(this._serviceUrl + "gmailStatus()", { method: "GET" }),
                    request(this._serviceUrl + "EmailAttachments?$filter=status ne 'PROCESSED'&$orderby=modifiedAt desc&$top=10" +
                        "&$select=fileName,status,errorMessage&$expand=message($select=sender)", { method: "GET" })
                ]);
                if (!status.ok) {
                    throw new Error(errorMessage(status));
                }
                this._setStatus(status.body);
                this._model.setProperty("/problems", problems.ok ? (problems.body.value || []).map(function (a) {
                    return { fileName: a.fileName, status: a.status, errorMessage: a.errorMessage, sender: a.message ? a.message.sender : "" };
                }) : []);
            } catch (error) {
                MessageBox.error("The Gmail status could not be loaded.", { details: error.message || String(error) });
            } finally {
                if (dialog) {
                    dialog.setBusy(false);
                }
            }
        },

        _setStatus: function (status) {
            this._model.setProperty("/status", status);
            this._model.setProperty("/view", gmailLogic.statusView(status, formatDateTime));
        },

        onRefreshStatus: function () {
            this.load();
        },

        onConnect: function () {
            // full-page redirect: Google's consent screen, then back to the app (?gmail=connected)
            window.location.assign(new URL("/auth/gmail/connect", window.location.href).href);
        },

        onDisconnect: function () {
            const address = this._model.getProperty("/view/emailAddress");
            MessageBox.confirm("Disconnect " + address + "? The app stops reading this mailbox and removes its stored Gmail authorization. " +
                "Already imported purchase orders and the processing history are kept.", {
                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.CANCEL,
                onClose: async function (action) {
                    if (action !== MessageBox.Action.OK) {
                        return;
                    }
                    this._dialog.setBusy(true);
                    try {
                        const result = await request(this._serviceUrl + "disconnectGmail", { method: "POST", body: "{}" });
                        if (!result.ok) {
                            MessageBox.error(errorMessage(result));
                            return;
                        }
                        this._setStatus(result.body);
                        MessageToast.show("Gmail disconnected.");
                    } finally {
                        this._dialog.setBusy(false);
                    }
                }.bind(this)
            });
        },

        onCheckNow: async function () {
            this._dialog.setBusy(true);
            try {
                const result = await request(this._serviceUrl + "checkGmailNow", { method: "POST", body: "{}" });
                if (!result.ok) {
                    MessageBox.error(errorMessage(result), { title: "Gmail check failed" });
                } else {
                    const r = result.body;
                    const box = (r.attachmentsFailed || (r.errors && r.errors.length)) ? MessageBox.warning : MessageBox.success;
                    box(gmailLogic.syncSummary(r), {
                        title: "Check Gmail",
                        details: r.errors && r.errors.length ? r.errors.join("\n") : undefined
                    });
                    if (this._hooks.onChanged) {
                        this._hooks.onChanged();
                    }
                }
            } catch (error) {
                MessageBox.error("Gmail could not be checked.", { details: error.message || String(error) });
            } finally {
                this._dialog.setBusy(false);
            }
            await this.load();
        },

        onClose: function () {
            this._dialog.close();
        },

        /** Handle the redirect back from /auth/gmail/callback (?gmail=connected | error). */
        handleRedirect: function () {
            const params = new URLSearchParams(window.location.search);
            const outcome = params.get("gmail");
            if (!outcome) {
                return;
            }
            const message = params.get("message");
            params.delete("gmail");
            params.delete("message");
            const query = params.toString();
            window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
            if (outcome === "connected") {
                MessageToast.show("Gmail connected. New purchase-order emails will be imported automatically.");
                this.open();
            } else {
                MessageBox.error(message || "Gmail could not be connected.", { title: "Gmail connection failed" });
            }
        }
    });
});
