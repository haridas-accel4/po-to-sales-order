sap.ui.define([
    "sap/ui/base/Object",
    "sap/ui/model/json/JSONModel",
    "sap/m/p13n/Popup",
    "sap/m/p13n/SelectionPanel",
    "sap/m/p13n/SortPanel",
    "po2so/salesorder/model/listSettingsLogic"
], function (BaseObject, JSONModel, P13nPopup, SelectionPanel, SortPanel, listSettingsLogic) {
    "use strict";

    function storage() {
        try {
            return window.localStorage;
        } catch {
            return null;
        }
    }

    /**
     * Personalization of the purchase order list with standard sap.m.p13n dialogs:
     *   - "Adapt Filters": show / hide the optional filter fields of the filter bar
     *   - "Table Settings": show / hide columns and sort the table
     * The settings live in the "listSettings" model (bound by the view) and are kept per browser.
     */
    return BaseObject.extend("po2so.salesorder.controller.ListSettingsManager", {

        /**
         * @param {sap.ui.core.mvc.View} view
         * @param {{onChanged:function(object)}} hooks onChanged(settings) after the user changed settings
         */
        constructor: function (view, hooks) {
            BaseObject.call(this);
            this._view = view;
            this._hooks = hooks || {};
            this._model = new JSONModel(listSettingsLogic.load(storage()));
            view.setModel(this._model, "listSettings");
        },

        /** Current settings ({filterVisible, columnVisible, sort}). */
        getSettings: function () {
            return listSettingsLogic.normalize(this._model.getData());
        },

        _apply: function (settings, persist) {
            const normalized = listSettingsLogic.normalize(settings);
            this._model.setData(normalized);
            if (persist !== false) {
                listSettingsLogic.save(storage(), normalized);
            }
            if (this._hooks.onChanged) {
                this._hooks.onChanged(normalized);
            }
        },

        /** Back to the delivered layout: all filters and columns, no sorting; stored preferences are removed. */
        reset: function () {
            listSettingsLogic.clear(storage());
            this._apply(listSettingsLogic.defaultSettings(), false);
        },

        openAdaptFilters: function (source) {
            if (!this._filterPanel) {
                this._filterPanel = new SelectionPanel(this._view.createId("adaptFiltersPanel"), {
                    title: "Filters",
                    showHeader: true,
                    enableCount: true,
                    enableReorder: false,
                    fieldColumn: "Filter Field",
                    activeColumn: "Shown"
                });
                this._filterPopup = new P13nPopup(this._view.createId("adaptFiltersDialog"), {
                    title: "Adapt Filters",
                    mode: "Dialog",
                    panels: [this._filterPanel],
                    warningText: "Restore the default filter fields?",
                    reset: function () {
                        this._filterPanel.setP13nData(listSettingsLogic.filterPanelData(listSettingsLogic.defaultSettings()));
                    }.bind(this),
                    close: function (event) {
                        if (event.getParameter("reason") !== "Ok") {
                            return;
                        }
                        const settings = this.getSettings();
                        settings.filterVisible = listSettingsLogic.visibilityFromPanel(
                            this._filterPanel.getP13nData(), listSettingsLogic.FILTER_FIELDS);
                        this._apply(settings);
                    }.bind(this)
                });
                this._view.addDependent(this._filterPopup);
            }
            this._filterPanel.setP13nData(listSettingsLogic.filterPanelData(this.getSettings()));
            this._filterPopup.open(source);
        },

        openTableSettings: function (source) {
            if (!this._columnPanel) {
                this._columnPanel = new SelectionPanel(this._view.createId("tableColumnsPanel"), {
                    title: "Columns",
                    showHeader: true,
                    enableCount: true,
                    enableReorder: false,
                    fieldColumn: "Column",
                    activeColumn: "Shown"
                });
                this._sortPanel = new SortPanel(this._view.createId("tableSortPanel"), { title: "Sort" });
                this._tablePopup = new P13nPopup(this._view.createId("tableSettingsDialog"), {
                    title: "Table Settings",
                    mode: "Dialog",
                    panels: [this._columnPanel, this._sortPanel],
                    warningText: "Restore the default columns and sorting?",
                    reset: function () {
                        const defaults = listSettingsLogic.defaultSettings();
                        this._columnPanel.setP13nData(listSettingsLogic.columnPanelData(defaults));
                        this._sortPanel.setP13nData(listSettingsLogic.sortPanelData(defaults));
                    }.bind(this),
                    close: function (event) {
                        if (event.getParameter("reason") !== "Ok") {
                            return;
                        }
                        const settings = this.getSettings();
                        settings.columnVisible = listSettingsLogic.visibilityFromPanel(
                            this._columnPanel.getP13nData(), listSettingsLogic.COLUMNS);
                        settings.sort = listSettingsLogic.sortFromPanel(this._sortPanel.getP13nData());
                        this._apply(settings);
                    }.bind(this)
                });
                this._view.addDependent(this._tablePopup);
            }
            const settings = this.getSettings();
            this._columnPanel.setP13nData(listSettingsLogic.columnPanelData(settings));
            this._sortPanel.setP13nData(listSettingsLogic.sortPanelData(settings));
            this._tablePopup.open(source);
        }
    });
});
