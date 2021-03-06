import {log} from '../log';
import {Db, DbSubOrder} from '../db/Db';
import {Settings} from '../Settings';

import express, {Express} from 'express';

import WebSocket from 'ws';

export class WebUI {
    settings: Settings;
    lastBalancesJson = '{}';
    frontendWs: WebSocket.Server;

    constructor(db: Db, settings: Settings, app: Express) {
        this.settings = settings;

        // STATIC

        app.use('/host.js', (req, res) => {
            const fileContent = `var BROKER_URL = "${settings.brokerWebServerUrl}"; // GENERATED `;
            res.setHeader('Content-Type', 'application/javascript');
            res.setHeader('Content-Length', fileContent.length);
            res.send(fileContent);
        });

        const www = express.static('broker-frontend/build');
        app.use(www);
        app.use('/stats', www);
        app.use('/dashboard', www);

        // REST

        app.get('/api/openorders', async (req, res) => {
            try {
                res.send(await db.getOpenSubOrders());
            } catch (error) {
                log.error(error);
                res.status(400);
                res.send({code: 1000, msg: error.message});
            }
        });

        app.get('/api/orderhistory', async (req, res) => {
            try {
                res.send(await db.getAllSubOrders());
            } catch (error) {
                log.error(error);
                res.status(400);
                res.send({code: 1000, msg: error.message});
            }
        });

        app.get('/api/balance', async (req, res) => {
            try {
                res.send(this.lastBalancesJson);
            } catch (error) {
                log.error(error);
                res.status(400);
                res.send({code: 1000, msg: error.message});
            }
        });
    }

    initWs() {
        const wss = new WebSocket.Server({port: this.settings.wsPort});
        log.debug('Broker websocket on ws://localhost:' + this.settings.wsPort);

        wss.on('connection', ws => {
            log.debug('Receive websocket connection');
            this.frontendWs = ws;

            ws.on('message', (message: string) => {
            });
        });
    }

    sendToFrontend(data: DbSubOrder): void {
        try {
            if (this.frontendWs) {
                this.frontendWs.send(JSON.stringify(data));
            }
        } catch (e) {
            log.error(e);
        }
    }
}