/* global FileReader */
sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/core/format/DateFormat",
    "sap/ui/core/Fragment",
    "sap/ui/Device",
    "sap/m/MessageToast",
    "sap/m/MessageBox",
    "po2so/salesorder/model/reviewLogic",
    "po2so/salesorder/model/filterLogic",
    "po2so/salesorder/model/mappingLogic",
    "po2so/salesorder/controller/MappingManager",
    "po2so/salesorder/model/gmailLogic",
    "po2so/salesorder/controller/GmailManager",
    "po2so/salesorder/model/listSettingsLogic",
    "po2so/salesorder/controller/ListSettingsManager"
], function (
    Controller,
    JSONModel,
    DateFormat,
    Fragment,
    Device,
    MessageToast,
    MessageBox,
    reviewLogic,
    filterLogic,
    mappingLogic,
    MappingManager,
    gmailLogic,
    GmailManager,
    listSettingsLogic,
    ListSettingsManager
) {
    "use strict";

    // Backend processing statuses (db/inbound-schema.cds -> InboundStatus)
    const STATUS = {
        RECEIVED:     { text: "Received",     state: "Information" },
        EXTRACTED:    { text: "Extracted",    state: "Information" },
        VALIDATED:    { text: "Validated",    state: "Success" },
        NEEDS_REVIEW: { text: "Needs Review", state: "Warning" },
        CREATED:      { text: "Created",      state: "Success" },
        FAILED:       { text: "Failed",       state: "Error" }
    };

    const MIME_BY_EXTENSION = {
        csv: "text/csv",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pdf: "application/pdf"
    };

    const MAX_FILE_SIZE_MB = 5; // must match cds.po2so.maxFileSize on the backend

    const RESULT_STRIP_TYPE = {
        VALIDATED: "Success",
        CREATED: "Success",
        NEEDS_REVIEW: "Warning",
        FAILED: "Error"
    };

    const ORDER_FIELDS = [
        "ID", "fileName", "mimeType", "customerId", "soldToParty", "customerPoNumber",
        "poDate", "status", "salesOrderNumber", "errorMessage", "createdAt", "source"
    ].join(",");

    // Gmail origin shown in the table tooltip and the review dialog
    const EMAIL_EXPAND = "emailAttachment($select=fileName;$expand=message($select=sender,subject,receivedAt))";

    const poDateFormat = DateFormat.getDateInstance({ style: "medium", UTC: true });
    const createdAtFormat = DateFormat.getDateTimeInstance({ style: "medium" });

    function fileExtension(fileName) {
        const match = /\.([^.]+)$/.exec(fileName || "");
        return match ? match[1].toLowerCase() : "";
    }

    /** Read a browser File as Base64 without the "data:...;base64," prefix. */
    function readFileAsBase64(file) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () {
                const dataUrl = String(reader.result || "");
                resolve(dataUrl.substring(dataUrl.indexOf(",") + 1));
            };
            reader.onerror = function () {
                reject(reader.error || new Error("The file could not be read."));
            };
            reader.readAsDataURL(file);
        });
    }

    /** Extract a readable message from a failed fetch Response (CAP / OData error JSON or plain text). */
    async function readError(response) {
        let message;
        let code;
        const body = await response.text().catch(function () { return ""; });
        try {
            const json = JSON.parse(body);
            message = json.error && json.error.message;
            code = json.error && json.error.code;
        } catch {
            message = body && body.length < 300 ? body : "";
        }
        if (response.status === 413) {
            message = "The file is too large for the server (maximum " + MAX_FILE_SIZE_MB + " MB).";
        }
        return {
            status: response.status,
            code: code || "",
            message: message || ("Request failed with HTTP " + response.status + " " + response.statusText + ".")
        };
    }

    return Controller.extend("po2so.salesorder.controller.App", {

        onInit: function () {
            this._allRecords = [];
            this._customers = [];
            this._serviceUrl = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/mainService/uri");

            this.getView().setModel(new JSONModel(filterLogic.emptyFilters()), "filters");

            this.getView().setModel(new JSONModel({
                records: []
            }), "records");

            this.getView().setModel(new JSONModel({
                processed: 0,
                salesOrders: 0,
                exceptions: 0
            }), "stats");

            this.getView().setModel(new JSONModel({
                customers: []
            }), "customers");

            this.getView().setModel(new JSONModel({
                customerId: "",
                canUpload: false,
                result: { visible: false, text: "", type: "Information" }
            }), "upload");

            this.getView().setModel(new JSONModel({}), "review");

            // mapping maintenance: reload records/customers whenever mappings or order statuses change
            this._mappings = new MappingManager(this.getView(), this._serviceUrl, {
                onChanged: function () { this.loadRecords(); }.bind(this)
            });

            // Gmail intake settings; new orders may arrive after "Check Gmail Now"
            this._gmail = new GmailManager(this.getView(), this._serviceUrl, {
                onChanged: function () { this.loadRecords(); }.bind(this)
            });

            // Adapt Filters / Table Settings (filter fields, columns, sorting), kept per browser
            this._listSettings = new ListSettingsManager(this.getView(), {
                onChanged: this._onListSettingsChanged.bind(this)
            });

            // official SAP logo shipped with the app (sap.com blocks hotlinking from browsers)
            this.byId("sapLogo").setSrc(sap.ui.require.toUrl("po2so/salesorder/img/sap-logo.svg"));

            this.loadRecords();
            // back from the Gmail OAuth callback (?gmail=connected | error)
            this._gmail.handleRedirect();
        },

        // ------------------------------------------------------------------ backend access

        /** GET a collection, following server-driven paging (@odata.nextLink). */
        _getAll: async function (path) {
            let url = this._serviceUrl + path;
            let rows = [];
            while (url) {
                const response = await fetch(url, { headers: { Accept: "application/json" } });
                if (!response.ok) {
                    throw await readError(response);
                }
                const json = await response.json();
                rows = rows.concat(json.value || []);
                url = json["@odata.nextLink"] ? new URL(json["@odata.nextLink"], new URL(this._serviceUrl, window.location.href)).href : null;
            }
            return rows;
        },

        loadRecords: async function () {
            const table = this.byId("poTable");
            table.setBusy(true);
            try {
                const [orders, customers] = await Promise.all([
                    this._getAll("InboundOrders?$select=" + ORDER_FIELDS + "&$expand=" + EMAIL_EXPAND + "&$orderby=createdAt desc"),
                    this._getAll("Customers?$select=customerId,customerName,soldToParty,active&$orderby=customerName")
                ]);

                this._customers = customers;
                this.getView().getModel("customers").setProperty("/customers",
                    customers.filter(function (c) { return c.active !== false; }));

                this._allRecords = orders.map(this._toRecord.bind(this));
                this.updateCounts();
                this._refreshTable();
                return true;
            } catch (error) {
                MessageBox.error("Purchase order records could not be loaded.", {
                    details: error.message || String(error)
                });
                return false;
            } finally {
                table.setBusy(false);
            }
        },

        /** Map a backend InboundOrder to the table row structure used by the view. */
        _toRecord: function (order) {
            const customer = this._customers.find(function (c) { return c.customerId === order.customerId; });
            const status = STATUS[order.status] || { text: order.status, state: "None" };
            let customerText = "";
            if (customer) {
                customerText = customer.customerName + " (" + customer.customerId + ")";
            } else if (order.customerId) {
                customerText = order.customerId;
            }

            const origin = gmailLogic.emailOrigin(order, function (iso) { return createdAtFormat.format(new Date(iso)); });

            return {
                ID: order.ID,
                fileName: order.fileName,
                source: order.source || "UPLOAD",
                sourceText: gmailLogic.sourceText(order.source || "UPLOAD"),
                sourceTooltip: origin ? "From " + origin.sender + ": " + origin.subject : "Uploaded manually",
                customer: customerText,
                customerId: order.customerId || "",
                soldToParty: order.soldToParty || "",
                poNumber: order.customerPoNumber || "",
                poDateIso: order.poDate || "",
                poDate: order.poDate ? poDateFormat.format(new Date(order.poDate + "T00:00:00Z")) : "",
                fileType: fileExtension(order.fileName).toUpperCase(),
                status: order.status,
                statusText: status.text,
                statusState: status.state,
                errorMessage: order.errorMessage || "",
                salesOrder: order.salesOrderNumber || "",
                createdOn: order.createdAt ? createdAtFormat.format(new Date(order.createdAt)) : "",
                createdAtIso: order.createdAt || ""
            };
        },

        // ------------------------------------------------------------------ table / tabs / filters

        updateCounts: function () {
            this.getView().getModel("stats").setData(filterLogic.tabCounts(this._allRecords));
        },

        updateTableTitle: function () {
            const count = this.getView().getModel("records").getProperty("/records").length;
            const selected = this.byId("mainTabs").getSelectedKey();

            const titles = {
                upload: "Purchase Order Records",
                processed: "Processed Purchase Orders",
                sales: "Sales Orders",
                exceptions: "Purchase Order Exceptions"
            };

            this.byId("tableTitle").setText(
                (titles[selected] || titles.upload) + " (" + count + ")"
            );
        },

        onTabSelect: function () {
            this._refreshTable();
        },

        /**
         * Show the records of the selected tab that match the current filter values,
         * sorted as set in Table Settings. All records are loaded (server-side paging is
         * followed in _getAll), so filtering and sorting run on the complete list and the
         * table's growing (50 rows at a time) starts again on the result.
         * @returns {boolean} false if the filter values are inconsistent
         */
        _refreshTable: function () {
            const values = this.getView().getModel("filters").getData();
            const selectedTab = this.byId("mainTabs").getSelectedKey();

            const problem = filterLogic.validateFilters(values);
            if (problem) {
                MessageToast.show(problem);
                return false;
            }

            const records = listSettingsLogic.sortRecords(
                filterLogic.applyFilters(this._allRecords, values, selectedTab),
                this._listSettings.getSettings().sort);
            this.getView().getModel("records").setProperty("/records", records);
            this.updateTableTitle();
            return true;
        },

        _filterDatePickers: function () {
            return [this.byId("filterDateFrom"), this.byId("filterDateTo")];
        },

        /** Whether a filter field is shown in the filter bar (see Adapt Filters). */
        _isFilterShown: function (control) {
            return control.getParent().getVisible();
        },

        /** "Go" (also Enter in a filter field): apply the filter bar and show the matching records. */
        onApplyFilters: function () {
            // a DatePicker does not write unparsable input to the model -> do not silently ignore it
            const invalid = this._filterDatePickers().find(function (picker) {
                return this._isFilterShown(picker) && picker.getValueState() === "Error";
            }, this);
            if (invalid) {
                MessageToast.show("Enter a valid date for '" + invalid.getParent().getItems()[0].getText() + "'.");
                return;
            }

            // the "PO Upload" tab shows the upload form, not the table -> show the results in a records tab
            const tabs = this.byId("mainTabs");
            if (tabs.getSelectedKey() === "upload") {
                tabs.setSelectedKey(filterLogic.resultTab(this.getView().getModel("filters").getData()));
            }
            this._refreshTable();
        },

        onFilterDateChange: function (event) {
            const picker = event.getSource();
            const valid = event.getParameter("valid") || !event.getParameter("value");
            picker.setValueState(valid ? "None" : "Error");
            picker.setValueStateText(valid ? "" : "Enter a valid date.");
        },

        _resetFilterInputs: function (values) {
            const model = this.getView().getModel("filters");
            model.setData(values);
            // force the values into the controls, also where the model value did not change
            // (e.g. unparsable text in a DatePicker that never reached the model)
            model.refresh(true);
            this._filterDatePickers().forEach(function (picker) {
                if (!picker.getValue()) {
                    picker.setValueState("None");
                    picker.setValueStateText("");
                }
            });
        },

        /** "Clear": reset search and every filter field and show the complete list of the selected tab. */
        onClearFilters: function () {
            this._resetFilterInputs(filterLogic.emptyFilters());
            this._refreshTable();
            MessageToast.show("Filters cleared.");
        },

        onSearch: function (event) {
            // "search" fires with `query` (also "" when the clear icon is pressed), "liveChange" with `newValue`
            const live = event.getId() === "liveChange";
            const query = live ? event.getParameter("newValue") : event.getParameter("query");
            this.getView().getModel("filters").setProperty("/search", query || "");
            if (!live && query) {
                this.onApplyFilters(); // Enter / search icon behaves like "Go"
            } else {
                this._refreshTable();
            }
        },

        // ------------------------------------------------------------------ list settings

        /** Hidden filter fields must not keep filtering the list; then apply columns / sorting. */
        _onListSettingsChanged: function (settings) {
            const values = this.getView().getModel("filters").getData();
            const visibleValues = listSettingsLogic.clearHiddenFilters(values, settings.filterVisible);
            if (JSON.stringify(visibleValues) !== JSON.stringify(values)) {
                this._resetFilterInputs(visibleValues);
            }
            // hidden date fields also drop unparsable input that never reached the model
            [["filterDateFrom", "dateFrom"], ["filterDateTo", "dateTo"]].forEach(function (pair) {
                const picker = this.byId(pair[0]);
                if (settings.filterVisible[pair[1]] === false) {
                    picker.setValue("");
                    picker.setValueState("None");
                    picker.setValueStateText("");
                }
            }, this);
            this._refreshTable();
        },

        onOpenAdaptFilters: function () {
            this._listSettings.openAdaptFilters(this.byId("adaptFiltersButton"));
        },

        onOpenTableSettings: function () {
            this._listSettings.openTableSettings(this.byId("tableSettingsButton"));
        },

        onResetListSettings: function () {
            this._listSettings.reset();
            MessageToast.show("Default filter fields, columns and sorting restored.");
        },

        onRefresh: async function () {
            if (await this.loadRecords()) {
                MessageToast.show("Records refreshed.");
            }
        },

        onRecordPress: async function (event) {
            const record = event.getSource().getBindingContext("records").getObject();
            await this.openReview(record.ID);
        },

        // ------------------------------------------------------------------ review / correction

        _getReviewDialog: async function () {
            if (!this._reviewDialog) {
                this._reviewDialog = await Fragment.load({
                    id: this.getView().getId(),
                    name: "po2so.salesorder.view.InboundOrderReview",
                    controller: this
                });
                this._reviewDialog.setStretch(Device.system.phone);
                this.getView().addDependent(this._reviewDialog);
            }
            return this._reviewDialog;
        },

        /** Open the review dialog for an inbound order. */
        openReview: async function (orderId) {
            const dialog = await this._getReviewDialog();
            dialog.open();
            dialog.setBusy(true);
            try {
                await this._loadReview(orderId);
            } catch (error) {
                dialog.close();
                MessageBox.error("The purchase order could not be loaded.", { details: error.message || String(error) });
            } finally {
                dialog.setBusy(false);
            }
        },

        /** (Re)load the order with items and issues from the backend into the review model. */
        _loadReview: async function (orderId) {
            const response = await fetch(this._serviceUrl + "InboundOrders(" + orderId + ")" +
                "?$expand=items($orderby=lineNumber),issues($orderby=lineNumber)," + EMAIL_EXPAND,
            { headers: { Accept: "application/json" } });
            if (!response.ok) {
                throw await readError(response);
            }
            const order = await response.json();

            this._reviewOrder = order;
            this._reviewOriginal = reviewLogic.toDraft(order);
            this._invalidInputs = {};
            const draft = reviewLogic.toDraft(order);
            const state = reviewLogic.reviewState(order);
            const status = STATUS[order.status] || { text: order.status, state: "None" };
            const itemsById = {};
            (order.items || []).forEach(function (i) { itemsById[i.ID] = i; });

            // customer choices: maintained, active customers + the current value if it is not maintained
            const customers = [{ key: "", text: "(no customer)", additionalText: "" }].concat(
                this._customers.filter(function (c) { return c.active !== false; }).map(function (c) {
                    return { key: c.customerId, text: c.customerName, additionalText: c.customerId };
                }));
            if (order.customerId && !customers.some(function (c) { return c.key === order.customerId; })) {
                customers.push({ key: order.customerId, text: order.customerId + " (not maintained)", additionalText: "" });
            }

            const confidence = order.extractionConfidence === null || order.extractionConfidence === undefined
                ? "" : " | confidence " + Number(order.extractionConfidence);

            this.getView().getModel("review").setData({
                editable: state.editable,
                readOnlyReason: state.reason,
                dirty: false,
                canSave: false,
                canRevalidate: state.editable,
                customers: customers,
                order: Object.assign({}, draft.header, {
                    ID: order.ID,
                    status: order.status,
                    statusText: status.text,
                    statusState: status.state,
                    errorMessage: order.errorMessage || "",
                    soldToParty: order.soldToParty || "",
                    fileName: order.fileName,
                    sourceText: gmailLogic.sourceText(order.source || "UPLOAD"),
                    email: gmailLogic.emailOrigin(order, function (iso) { return createdAtFormat.format(new Date(iso)); }),
                    fileUrl: order.file_ID ? this._serviceUrl + "InboundFiles(" + order.file_ID + ")/content" : "",
                    extraction: (order.extractionMethod || "not extracted") + confidence
                }),
                items: draft.items.map(function (item) {
                    const source = itemsById[item.ID];
                    return Object.assign(item, {
                        material: source.material || "",
                        sapUom: source.sapUom || "",
                        customerUnitPrice: source.customerUnitPrice === null || source.customerUnitPrice === undefined
                            ? "" : Number(source.customerUnitPrice).toFixed(2),
                        vs: {},
                        highlight: "None"
                    });
                }),
                issues: (order.issues || []).map(function (issue) {
                    return {
                        severity: issue.severity,
                        severityText: issue.severity === "ERROR" ? "Error" : "Warning",
                        severityState: issue.severity === "ERROR" ? "Error" : "Warning",
                        code: issue.code,
                        field: issue.field,
                        fieldLabel: reviewLogic.fieldLabel(issue.field),
                        lineNumber: issue.lineNumber || "",
                        message: issue.message,
                        // "Add Mapping" is offered for unmapped material / UoM issues of correctable orders
                        canAddMapping: state.editable && !!mappingLogic.draftFromIssue(issue, order,
                            (order.items || []).find(function (i) { return i.lineNumber === issue.lineNumber; }))
                    };
                }),
                headerVs: {}
            });
            this._refreshReviewState();
        },

        /** Recompute dirty flag, client-side format errors and value states from the review model. */
        _refreshReviewState: function () {
            const model = this.getView().getModel("review");
            const data = model.getData();
            const draft = {
                header: {
                    customerId: data.order.customerId,
                    customerPoNumber: data.order.customerPoNumber,
                    poDate: data.order.poDate,
                    requestedDeliveryDate: data.order.requestedDeliveryDate
                },
                items: data.items
            };
            const changes = reviewLogic.buildChanges(this._reviewOriginal, draft);
            const clientErrors = reviewLogic.validateDraft(draft, this._invalidInputs);
            const serverStates = reviewLogic.issueStates(this._reviewOrder.issues);

            const headerVs = {};
            reviewLogic.HEADER_FIELDS.forEach(function (field) {
                if (clientErrors.header[field]) {
                    headerVs[field] = { state: "Error", text: clientErrors.header[field] };
                } else if (serverStates.header[field]) {
                    headerVs[field] = serverStates.header[field];
                }
            });
            model.setProperty("/headerVs", headerVs);

            data.items.forEach(function (item, index) {
                const line = serverStates.lines[item.lineNumber] || { fields: {}, highlight: "None" };
                const errors = clientErrors.items[item.ID] || {};
                const vs = {};
                reviewLogic.ITEM_FIELDS.forEach(function (field) {
                    if (errors[field]) {
                        vs[field] = { state: "Error", text: errors[field] };
                    } else if (line.fields[field]) {
                        vs[field] = line.fields[field];
                    }
                });
                model.setProperty("/items/" + index + "/vs", vs);
                model.setProperty("/items/" + index + "/highlight", Object.keys(errors).length ? "Error" : line.highlight);
            });

            this._reviewChanges = changes;
            model.setProperty("/dirty", changes.count > 0);
            model.setProperty("/canSave", data.editable && changes.count > 0 && clientErrors.count === 0);
            model.setProperty("/canRevalidate", data.editable && changes.count === 0);
        },

        onReviewChange: function () {
            // let two-way binding write the new value first
            Promise.resolve().then(this._refreshReviewState.bind(this));
        },

        onReviewDateChange: function (event) {
            const id = event.getSource().getId();
            const field = /reviewPoDate$/.test(id) ? "poDate" : "requestedDeliveryDate";
            const value = event.getParameter("value");
            // DatePicker does not write unparsable input to the model -> track it explicitly
            this._invalidInputs[field] = !!value && !event.getParameter("valid");
            this.onReviewChange();
        },

        onReviewSave: async function () {
            const changes = this._reviewChanges;
            const dialog = this._reviewDialog;
            const orderId = this._reviewOrder.ID;
            if (!changes || !changes.count) {
                return;
            }

            dialog.setBusy(true);
            try {
                const response = await fetch(this._serviceUrl + "$batch", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: JSON.stringify(reviewLogic.buildBatch(orderId, changes))
                });
                if (!response.ok) {
                    throw await readError(response);
                }
                const errors = reviewLogic.batchErrors(await response.json());
                if (errors.length) {
                    MessageBox.error("The changes were not saved. Nothing has been changed.", {
                        title: "Save failed",
                        details: errors.join("\n")
                    });
                    return;
                }

                await this._loadReview(orderId);
                this._announceStatus("Changes saved and revalidated.");
                this.loadRecords();
            } catch (error) {
                MessageBox.error("The changes could not be saved.", { details: error.message || String(error) });
            } finally {
                dialog.setBusy(false);
            }
        },

        onReviewRevalidate: async function () {
            const dialog = this._reviewDialog;
            const orderId = this._reviewOrder.ID;
            dialog.setBusy(true);
            try {
                const response = await fetch(this._serviceUrl + "InboundOrders(" + orderId + ")/revalidate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: "{}"
                });
                if (!response.ok) {
                    throw await readError(response);
                }
                await this._loadReview(orderId);
                this._announceStatus("Revalidation completed.");
                this.loadRecords();
            } catch (error) {
                MessageBox.error(error.message || "Revalidation failed.", { title: "Revalidation failed" });
            } finally {
                dialog.setBusy(false);
            }
        },

        onReviewResubmit: async function () {
            const dialog = this._reviewDialog;
            const orderId = this._reviewOrder.ID;
            dialog.setBusy(true);
            try {
                const response = await fetch(this._serviceUrl + "InboundOrders(" + orderId + ")/resubmit", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: "{}"
                });
                if (!response.ok) {
                    throw await readError(response);
                }
                const result = await response.json();
                await this._loadReview(orderId);
                this.loadRecords();
                if (result.status === "CREATED") {
                    MessageBox.success("Sales Order " + result.salesOrderNumber + " was created in SAP.", { title: "Sales Order created" });
                } else {
                    this._announceStatus("Resubmitted; no Sales Order was created.");
                }
            } catch (error) {
                MessageBox.error(error.message || "Resubmit failed.", { title: "Resubmit failed" });
            } finally {
                dialog.setBusy(false);
            }
        },

        /** "Add Mapping" on a MATERIAL_UNMAPPED / UOM_UNMAPPED issue: create the mapping, then revalidate this order. */
        onReviewAddMapping: async function (event) {
            const issue = event.getSource().getBindingContext("review").getObject();
            const reviewModel = this.getView().getModel("review");
            if (reviewModel.getProperty("/dirty")) {
                MessageToast.show("Save or discard your changes before adding a mapping.");
                return;
            }
            const order = this._reviewOrder;
            const item = (order.items || []).find(function (i) { return i.lineNumber === issue.lineNumber; });
            const plan = mappingLogic.draftFromIssue(issue, order, item);
            if (!plan) {
                return;
            }
            const saved = await this._mappings.openEditor(plan.type, null, {
                draft: plan.draft,
                locked: plan.locked,
                hint: "The new mapping is used for this order immediately. Other open orders pick it up with 'Revalidate Open Orders' in Manage Mappings."
            });
            if (!saved) {
                return;
            }

            const dialog = this._reviewDialog;
            dialog.setBusy(true);
            try {
                const response = await fetch(this._serviceUrl + "InboundOrders(" + order.ID + ")/revalidate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: "{}"
                });
                if (!response.ok) {
                    throw await readError(response);
                }
                await this._loadReview(order.ID);
                this._announceStatus("Mapping created and order revalidated.");
                this.loadRecords();
            } catch (error) {
                MessageBox.error("The mapping was created, but the order could not be revalidated.", { details: error.message || String(error) });
            } finally {
                dialog.setBusy(false);
            }
        },

        onOpenMappings: function () {
            this._mappings.open();
        },

        onOpenGmail: function () {
            this._gmail.open();
        },

        _announceStatus: function (prefix) {
            const data = this.getView().getModel("review").getData();
            const errors = data.issues.filter(function (i) { return i.severity === "ERROR"; }).length;
            MessageToast.show(prefix + " Status: " + data.order.statusText +
                (errors ? " (" + errors + " error(s) remaining)." : "."));
        },

        onReviewClose: function () {
            const dialog = this._reviewDialog;
            if (!this.getView().getModel("review").getProperty("/dirty")) {
                dialog.close();
                return;
            }
            MessageBox.confirm("Discard your unsaved changes?", {
                actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                emphasizedAction: MessageBox.Action.NO,
                onClose: function (action) {
                    if (action === MessageBox.Action.YES) {
                        dialog.close();
                    }
                }
            });
        },

        onReviewEscape: function (promise) {
            if (this.getView().getModel("review").getProperty("/dirty")) {
                promise.reject();
                this.onReviewClose();
            } else {
                promise.resolve();
            }
        },

        // ------------------------------------------------------------------ upload

        onFileChange: function (event) {
            const file = event.getParameter("files") && event.getParameter("files")[0];
            this._selectedFile = null;
            this._updateCanUpload();

            if (!file) {
                return;
            }

            const allowed = /\.(pdf|csv|xlsx)$/i.test(file.name);
            if (!allowed) {
                MessageBox.error("Please select a PDF, CSV or XLSX file.");
                this.byId("poFileUploader").clear();
                return;
            }

            if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                MessageBox.error("File size must not exceed " + MAX_FILE_SIZE_MB + " MB.");
                this.byId("poFileUploader").clear();
                return;
            }

            if (file.size === 0) {
                MessageBox.error("The selected file is empty.");
                this.byId("poFileUploader").clear();
                return;
            }

            this._selectedFile = file;
            this._updateCanUpload();
            MessageToast.show("Selected: " + file.name);
        },

        onFileTypeMismatch: function () {
            MessageBox.error("Please select a PDF, CSV or XLSX file.");
        },

        onFileSizeExceed: function () {
            MessageBox.error("File size must not exceed " + MAX_FILE_SIZE_MB + " MB.");
        },

        onUploadResultClose: function () {
            this.getView().getModel("upload").setProperty("/result/visible", false);
        },

        _updateCanUpload: function () {
            this.getView().getModel("upload").setProperty("/canUpload", !!this._selectedFile && !this._uploading);
        },

        onUpload: function () {
            if (!this._selectedFile || this._uploading) {
                return;
            }
            if (this.getView().getModel("upload").getProperty("/customerId")) {
                this._uploadFile();
                return;
            }
            // without a customer the materials cannot be mapped: the PO waits in Exceptions
            const uploadAnyway = "Upload Anyway";
            MessageBox.warning("No customer is selected. Customer materials can only be mapped for a known customer, " +
                "so this purchase order will wait in Exceptions until a customer is set there.", {
                title: "No Customer Selected",
                actions: [uploadAnyway, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.CANCEL,
                onClose: function (action) {
                    if (action === uploadAnyway) {
                        this._uploadFile();
                    } else {
                        this.byId("uploadCustomer").focus();
                    }
                }.bind(this)
            });
        },

        _uploadFile: async function () {
            const file = this._selectedFile;
            if (!file || this._uploading) {
                return;
            }

            const uploadModel = this.getView().getModel("upload");
            const panel = this.byId("uploadPanel");
            const customerId = uploadModel.getProperty("/customerId") || null;
            const mimeType = file.type || MIME_BY_EXTENSION[fileExtension(file.name)] || "application/octet-stream";

            this._uploading = true;
            this._updateCanUpload();
            uploadModel.setProperty("/result/visible", false);
            panel.setBusyIndicatorDelay(0);
            panel.setBusy(true);

            try {
                const content = await readFileAsBase64(file);
                const response = await fetch(this._serviceUrl + "uploadPurchaseOrder", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json" },
                    body: JSON.stringify({ fileName: file.name, mimeType: mimeType, content: content, customerId: customerId })
                });

                if (!response.ok) {
                    const error = await readError(response);
                    const title = error.status === 400 ? "The file was rejected" : "Upload failed";
                    MessageBox.error(error.message, {
                        title: title,
                        details: "HTTP " + error.status + (error.code ? " | " + error.code : "")
                    });
                    return;
                }

                const result = await response.json();
                const status = STATUS[result.status] || { text: result.status };
                let text = result.salesOrderNumber
                    ? file.name + " uploaded. Sales Order " + result.salesOrderNumber + " created in SAP."
                    : file.name + " uploaded. Status: " + status.text + ".";
                if (result.errorCount) {
                    text += " " + result.errorCount + " error(s): " + (result.errorMessage || "").split("\n").slice(0, 3).join(" ");
                }
                if (result.warningCount) {
                    text += " " + result.warningCount + " warning(s).";
                }
                uploadModel.setProperty("/result", {
                    visible: true,
                    text: text,
                    type: RESULT_STRIP_TYPE[result.status] || "Information"
                });
                MessageToast.show(file.name + " uploaded (" + status.text + ").");

                // the file is stored on the server in every case -> reset the selection
                this.byId("poFileUploader").clear();
                this._selectedFile = null;
                await this.loadRecords();
            } catch (error) {
                MessageBox.error("The upload could not be completed.", { details: error.message || String(error) });
            } finally {
                this._uploading = false;
                this._updateCanUpload();
                panel.setBusy(false);
            }
        }

    });
});
