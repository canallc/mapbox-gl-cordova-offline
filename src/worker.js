// @flow

import Actor from 'mapbox-gl/src/util/actor';

import StyleLayerIndex from 'mapbox-gl/src/style/style_layer_index';
import VectorTileWorkerSource from 'mapbox-gl/src/source/vector_tile_worker_source';
import RasterDEMTileWorkerSource from 'mapbox-gl/src/source/raster_dem_tile_worker_source';
import GeoJSONWorkerSource from 'mapbox-gl/src/source/geojson_worker_source';
import { plugin as globalRTLTextPlugin } from 'mapbox-gl/src/source/rtl_text_plugin';
import vt from '@mapbox/vector-tile';
import Protobuf from 'pbf';



import type {
    WorkerSource,
    WorkerTileParameters,
    WorkerDEMTileParameters,
    WorkerTileCallback,
    WorkerDEMTileCallback,
    TileParameters
} from 'mapbox-gl/src/source/worker_source';

import type {WorkerGlobalScopeInterface} from 'mapbox-gl/src/util/web_worker';
import type {Callback} from 'mapbox-gl/src/types/callback';

import { USE_ONLINE } from './mbtiles_source';

/**
 * @private
 */
export default class Worker {
    self: WorkerGlobalScopeInterface;
    actor: Actor;
    layerIndexes: { [string]: StyleLayerIndex };
    workerSourceTypes: { [string]: Class<WorkerSource> };
    workerSources: { [string]: { [string]: { [string]: WorkerSource } } };
    demWorkerSources: { [string]: { [string]: RasterDEMTileWorkerSource } };

    constructor(self: WorkerGlobalScopeInterface) {
        this.self = self;
        this.actor = new Actor(self, this);

        this.layerIndexes = {};

        this.workerSourceTypes = {
            vector: VectorTileWorkerSource,
            mbtiles: VectorTileWorkerSource,
            geojson: GeoJSONWorkerSource
        };

        // [mapId][sourceType][sourceName] => worker source instance
        this.workerSources = {};
        this.demWorkerSources = {};

        this.self.registerWorkerSource = (name: string, WorkerSource: Class<WorkerSource>) => {
            if (this.workerSourceTypes[name]) {
                throw new Error(`Worker source with name "${name}" already registered.`);
            }
            this.workerSourceTypes[name] = WorkerSource;
        };

        this.self.registerRTLTextPlugin = (rtlTextPlugin: {applyArabicShaping: Function, processBidirectionalText: Function}) => {
            if (globalRTLTextPlugin.isLoaded()) {
                throw new Error('RTL text plugin already registered.');
            }
            globalRTLTextPlugin['applyArabicShaping'] = rtlTextPlugin.applyArabicShaping;
            globalRTLTextPlugin['processBidirectionalText'] = rtlTextPlugin.processBidirectionalText;
        };
    }

    setLayers(mapId: string, layers: Array<LayerSpecification>, callback: WorkerTileCallback) {
        this.getLayerIndex(mapId).replace(layers);
        callback();
    }

    updateLayers(mapId: string, params: {layers: Array<LayerSpecification>, removedIds: Array<string>}, callback: WorkerTileCallback) {
        this.getLayerIndex(mapId).update(params.layers, params.removedIds);
        callback();
    }

    loadTile(mapId: string, params: WorkerTileParameters & {type: string}, callback: WorkerTileCallback) {
        this.getWorkerSource(mapId, params.type, params.source).loadTile(params, callback);
    }

    loadDEMTile(mapId: string, params: WorkerDEMTileParameters, callback: WorkerDEMTileCallback) {
        this.getDEMWorkerSource(mapId, params.source).loadTile(params, callback);
    }

    reloadTile(mapId: string, params: WorkerTileParameters & {type: string}, callback: WorkerTileCallback) {
        this.getWorkerSource(mapId, params.type, params.source).reloadTile(params, callback);
    }

    abortTile(mapId: string, params: TileParameters & {type: string}, callback: WorkerTileCallback) {
        this.getWorkerSource(mapId, params.type, params.source).abortTile(params, callback);
    }

    removeTile(mapId: string, params: TileParameters & {type: string}, callback: WorkerTileCallback) {
        this.getWorkerSource(mapId, params.type, params.source).removeTile(params, callback);
    }

    removeDEMTile(mapId: string, params: TileParameters) {
        this.getDEMWorkerSource(mapId, params.source).removeTile(params);
    }

    removeSource(mapId: string, params: {source: string} & {type: string}, callback: WorkerTileCallback) {
        if (!this.workerSources[mapId] ||
            !this.workerSources[mapId][params.type] ||
            !this.workerSources[mapId][params.type][params.source]) {
            return;
        }

        const worker = this.workerSources[mapId][params.type][params.source];
        delete this.workerSources[mapId][params.type][params.source];

        if (worker.removeSource !== undefined) {
            worker.removeSource(params, callback);
        } else {
            callback();
        }
    }

    /**
     * Load a {@link WorkerSource} script at params.url.  The script is run
     * (using importScripts) with `registerWorkerSource` in scope, which is a
     * function taking `(name, workerSourceObject)`.
     *  @private
     */
    loadWorkerSource(map: string, params: { url: string }, callback: Callback<void>) {
        try {
            this.self.importScripts(params.url);
            callback();
        } catch (e) {
            callback(e.toString());
        }
    }

    loadRTLTextPlugin(map: string, pluginURL: string, callback: Callback<void>) {
        try {
            if (!globalRTLTextPlugin.isLoaded()) {
                this.self.importScripts(pluginURL);
                callback(globalRTLTextPlugin.isLoaded() ?
                    null :
                    new Error(`RTL Text Plugin failed to import scripts from ${pluginURL}`));
            }
        } catch (e) {
            callback(e.toString());
        }
    }

    getLayerIndex(mapId: string) {
        let layerIndexes = this.layerIndexes[mapId];
        if (!layerIndexes) {
            layerIndexes = this.layerIndexes[mapId] = new StyleLayerIndex();
        }
        return layerIndexes;
    }

    getWorkerSource(mapId: string, type: string, source: string) {
        if (!this.workerSources[mapId])
            this.workerSources[mapId] = {};
        if (!this.workerSources[mapId][type])
            this.workerSources[mapId][type] = {};

        if (!this.workerSources[mapId][type][source]) {
            // use a wrapped actor so that we can attach a target mapId param
            // to any messages invoked by the WorkerSource
            const actor = {
                send: (type, data, callback) => {
                    this.actor.send(type, data, callback, mapId);
                }
            };

            //Custom load data for offline vector
            var loadOffData = function(params, callback){
                //callback(null, params.);
                var oKeys = Object.keys(this.loaded).sort(function(a, b) {
                    return a - b;
                });
                var i = 0;
                while(Object.keys(this.loaded).length>10){
                    delete this.loaded[oKeys[i]];
                    i++;
                }

                callback(null, {
                    vectorTile: new vt.VectorTile(new Protobuf(params.customData)),
                    rawData: params.customData,
                    cacheControl: null,
                    expires: null
                });
            }

            if(USE_ONLINE){
                this.workerSources[mapId][type][source] = new (this.workerSourceTypes[type]: any)((actor: any), this.getLayerIndex(mapId));
            }
            else{
                this.workerSources[mapId][type][source] = new (this.workerSourceTypes[type]: any)((actor: any), this.getLayerIndex(mapId), loadOffData);
            } 
            
        }

        return this.workerSources[mapId][type][source];
    }

    getDEMWorkerSource(mapId: string, source: string) {
        if (!this.demWorkerSources[mapId])
            this.demWorkerSources[mapId] = {};

        if (!this.demWorkerSources[mapId][source]) {
            this.demWorkerSources[mapId][source] = new RasterDEMTileWorkerSource();
        }

        return this.demWorkerSources[mapId][source];
    }
}

/* global self, WorkerGlobalScope */
if (typeof WorkerGlobalScope !== 'undefined' &&
    typeof self !== 'undefined' &&
    self instanceof WorkerGlobalScope) {
    new Worker(self);
}
