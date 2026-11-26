sap.ui.define([
    "sap/ui/base/Object",
    "sap/ui/core/Fragment",
    "sap/ui/model/json/JSONModel",
    "sap/ui/Device",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "po2so/salesorder/model/mappingLogic"
], function (BaseObject, Fragment, JSONModel, Device, MessageToast, MessageBox, mappingLogic) {
    "use strict";

    const TYPES = mappingLogic.TYPES;

    /** fetch wrapper returning { ok, status, body } (body = parsed JSON or null) */
    async function request(url, options) {
        const response = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json", Accept: "application/json" } }, options));
        const text = await response.text();
        let body;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { error: { message: text && text.length < 300 ? text : ("HTTP " + response.status) } };
        }
        return { ok: response.ok, status: response.status, body: body };
    }

    function errorMessage(result) {
        return (result.body && result.body.error && result.body.error.message) || ("Request failed with HTTP " + result.status + ".");
    }

    /**
     * Mapping maintenance (Customers, Material Mappings, UoM Mappings) and bulk revalidation.
     * Owns the "Manage Mappings" and "Edit Mapping" dialogs; used by App.controller.
     */
    return BaseObject.extend("po2so.salesorder.controller.MappingManager", {

        /**
         * @param {sap.ui.core.mvc.View} view
         * @param {string} serviceUrl OData service root (with trailing slash)
         * @param {{onChanged:function}} hooks onChanged is called after master data or order statuses changed
         */
        constructor: function (view, serviceUrl, hooks) {
            BaseObject.call(this);
            this._view = view;
            this._serviceUrl = serviceUrl;
            this._hooks = hooks || {};
            const empty = function () { return { rows: [], view: [], query: "", selected: null }; };
            this._model = new JSONModel({ tab: "customers", customers: empty(), materials: empty(), uoms: empty() });
            this._editModel = new JSONModel({});
            view.setModel(this._model, "mappings");
            view.setModel(this._editModel, "mappingEdit");
        },

        // ------------------------------------------------------------ dialogs

        _loadFragment: async function (name) {
            const dialog = await Fragment.load({ id: this._view.getId(), name: "po2so.salesorder.view." + name, controller: this });
            dialog.setStretch(Device.system.phone);
            this._view.addDependent(dialog);
            return dialog;
        },

        /** Open the Manage Mappings dialog. */
        open: async function (tab) {
            if (!this._dialog) {
                this._dialog = await this._loadFragment("ManageMappings");
            }
            if (tab) {
                this._model.setProperty("/tab", tab);
            }
            this._dialog.open();
            await this.load();
        },

        /** (Re)load all mapping tables. */
        load: async function () {
            const busy = this._dialog && this._dialog.isOpen() ? this._dialog : null;
            if (busy) {
                busy.setBusy(true);
            }
            try {
                const [customers, materials, uoms] = await Promise.all([
                    this._getAll("Customers?$orderby=customerId"),
                    this._getAll("MaterialMappings?$orderby=soldToParty,customerMaterial"),
                    this._getAll("UomMappings?$orderby=externalUom")
                ]);
                const names = {};
                customers.forEach(function (c) { names[c.soldToParty] = names[c.soldToParty] || c.customerName; });
                materials.forEach(function (m) { m.customerName = names[m.soldToParty] || ""; });
                this._customers = customers;
                this._setRows("customers", customers);
                this._setRows("materials", materials);
                this._setRows("uoms", uoms);
            } catch (error) {
                MessageBox.error("Mappings could not be loaded.", { details: error.message || String(error) });
            } finally {
                if (busy) {
                    busy.setBusy(false);
                }
            }
        },

        _getAll: async function (path) {
            let url = this._serviceUrl + path;
            let rows = [];
            while (url) {
                const result = await request(url, { method: "GET" });
                if (!result.ok) {
                    throw new Error(errorMessage(result));
                }
                rows = rows.concat(result.body.value || []);
                url = result.body["@odata.nextLink"] ? new URL(result.body["@odata.nextLink"], new URL(this._serviceUrl, window.location.href)).href : null;
            }
            return rows;
        },

        _setRows: function (type, rows) {
            this._model.setProperty("/" + type + "/rows", rows);
            this._model.setProperty("/" + type + "/selected", null);
            this._applySearch(type);
            const table = this._view.byId(type + "Table");
            if (table) {
                table.removeSelections(true);
            }
        },

        _applySearch: function (type) {
            const data = this._model.getProperty("/" + type);
            this._model.setProperty("/" + type + "/view", mappingLogic.filterRows(type, data.rows, data.query));
        },

        _tab: function () {
            return this._model.getProperty("/tab");
        },

        // ------------------------------------------------------------ Manage Mappings handlers

        onMappingTabSelect: function () {
            // selectedKey is two-way bound
        },

        onMappingSearch: function (event) {
            const type = this._tab();
            const query = event.getId() === "liveChange" ? event.getParameter("newValue") : event.getParameter("query");
            this._model.setProperty("/" + type + "/query", query || "");
            this._applySearch(type);
        },

        onMappingSelect: function (event) {
            const item = event.getParameter("listItem");
            this._model.setProperty("/" + this._tab() + "/selected", item ? item.getBindingContext("mappings").getObject() : null);
        },

        onMappingAdd: function () {
            this.openEditor(this._tab(), null);
        },

        onMappingEdit: function () {
            const type = this._tab();
            const row = this._model.getProperty("/" + type + "/selected");
            if (row) {
                this.openEditor(type, row);
            }
        },

        onMappingToggleActive: function () {
            const type = this._tab();
            const def = TYPES[type];
            const row = this._model.getProperty("/" + type + "/selected");
            if (!row || !def.canDeactivate) {
                return;
            }
            const activate = row.active === false;
            const label = type === "customers" ? "customer " + row.customerId : "mapping " + row.customerMaterial + " (" + row.soldToParty + ")";
            const run = async function () {
                this._dialog.setBusy(true);
                try {
                    const result = await request(this._serviceUrl + mappingLogic.keyPredicate(type, row), {
                        method: "PATCH", body: JSON.stringify({ active: activate })
                    });
                    if (!result.ok) {
                        MessageBox.error(errorMessage(result));
                        return;
                    }
                    MessageToast.show((activate ? "Activated " : "Deactivated ") + label + ". Revalidate open orders to apply the change.");
                    await this.load();
                    this._notifyChanged();
                } finally {
                    this._dialog.setBusy(false);
                }
            }.bind(this);

            if (activate) {
                run();
                return;
            }
            MessageBox.confirm("Deactivate " + label + "? It will no longer be used when purchase orders are validated.", {
                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.OK,
                onClose: function (action) {
                    if (action === MessageBox.Action.OK) {
                        run();
                    }
                }
            });
        },

        onRevalidateOpenOrders: async function () {
            this._dialog.setBusy(true);
            try {
                const result = await this.revalidateOpenOrders();
                if (result) {
                    (result.errors ? MessageBox.warning : MessageBox.success)(mappingLogic.revalidationSummary(result), {
                        title: "Revalidate Open Orders",
                        details: mappingLogic.revalidationDetails(result) || undefined
                    });
                }
            } finally {
                this._dialog.setBusy(false);
            }
        },

        /** POST revalidateOpenOrders(); returns the summary or null on error (message shown). */
        revalidateOpenOrders: async function () {
            const result = await request(this._serviceUrl + "revalidateOpenOrders", { method: "POST", body: "{}" });
            if (!result.ok) {
                MessageBox.error(errorMessage(result), { title: "Revalidation failed" });
                return null;
            }
            this._notifyChanged();
            return result.body;
        },

        onMappingsRefresh: function () {
            this.load();
        },

        onMappingsClose: function () {
            this._dialog.close();
        },

        onMappingsAfterClose: function () {
            this._notifyChanged();
        },

        _notifyChanged: function () {
            if (this._hooks.onChanged) {
                this._hooks.onChanged();
            }
        },

        // ------------------------------------------------------------ add / edit dialog

        /**
         * Open the add/edit dialog.
         * @param {string} type customers | materials | uoms
         * @param {object|null} row existing row (edit) or null (add)
         * @param {{draft?:object, locked?:string[], hint?:string}} [options]
         * @returns {Promise<object|null>} saved row, or null if cancelled
         */
        openEditor: async function (type, row, options) {
            const opts = options || {};
            const def = TYPES[type];
            if (!this._editDialog) {
                this._editDialog = await this._loadFragment("MappingEdit");
            }
            if (!this._customers) {
                this._customers = await this._getAll("Customers").catch(function () { return []; });
            }
            const editable = {};
            def.fields.forEach(function (f) {
                const isKey = def.keys.indexOf(f.name) >= 0;
                editable[f.name] = !(row && isKey) && !(opts.locked || []).includes(f.name);
            });
            this._editOriginal = row;
            this._editModel.setData({
                type: type,
                title: (row ? "Edit " : "Add ") + def.heading,
                hint: opts.hint || "",
                draft: row ? mappingLogic.draftFromRow(type, row) : (opts.draft || mappingLogic.newDraft(type)),
                editable: editable,
                vs: {},
                soldToOptions: mappingLogic.soldToOptions(this._customers)
            });
            this._editDialog.open();
            return new Promise(function (resolve) { this._editResolve = resolve; }.bind(this));
        },

        onMappingSave: async function () {
            const data = this._editModel.getData();
            const type = data.type;
            const original = this._editOriginal;
            const errors = mappingLogic.validateDraft(type, data.draft);
            this._editModel.setProperty("/vs", errors);
            if (Object.keys(errors).length) {
                return;
            }
            const body = mappingLogic.buildPayload(type, data.draft, original);
            if (original && !Object.keys(body).length) {
                MessageToast.show("No changes to save.");
                this._closeEditor(null);
                return;
            }

            this._editDialog.setBusy(true);
            try {
                const result = original
                    ? await request(this._serviceUrl + mappingLogic.keyPredicate(type, original), { method: "PATCH", body: JSON.stringify(body) })
                    : await request(this._serviceUrl + TYPES[type].entitySet, { method: "POST", body: JSON.stringify(body) });
                if (!result.ok) {
                    const targets = mappingLogic.errorTargets(result.body && result.body.error);
                    this._editModel.setProperty("/vs", targets);
                    MessageBox.error(errorMessage(result), {
                        title: result.status === 409 ? "Conflict" : "Mapping not saved"
                    });
                    return;
                }
                MessageToast.show(TYPES[type].singular.charAt(0).toUpperCase() + TYPES[type].singular.slice(1) + " saved.");
                this._closeEditor(result.body);
                if (this._dialog && this._dialog.isOpen()) {
                    await this.load();
                }
                this._customers = null; // reload sold-to choices next time
                this._notifyChanged();
            } catch (error) {
                MessageBox.error("The mapping could not be saved.", { details: error.message || String(error) });
            } finally {
                this._editDialog.setBusy(false);
            }
        },

        onMappingCancel: function () {
            this._closeEditor(null);
        },

        onMappingEditAfterClose: function () {
            // closed via Escape: resolve as cancelled
            if (this._editResolve) {
                this._editResolve(null);
                this._editResolve = null;
            }
        },

        _closeEditor: function (saved) {
            const resolve = this._editResolve;
            this._editResolve = null;
            this._editDialog.close();
            if (resolve) {
                resolve(saved);
            }
        }
    });
});
