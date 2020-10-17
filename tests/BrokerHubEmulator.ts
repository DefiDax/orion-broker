import {
    BrokerHub,
    BrokerHubRegisterRequest,
    CancelOrderRequest,
    CreateOrderRequest,
    OrderStatusResponse, TradeRequest
} from "../src/hub/BrokerHub";
import {Settings} from "../src/Settings";
import {DbOrder} from "../src/db/Db";
import {log} from "../src/log";

export class BrokerHubEmulator implements BrokerHub {
    private settings: Settings;

    onCreateOrder: (data: CreateOrderRequest) => Promise<DbOrder>;

    onCancelOrder: (data: CancelOrderRequest) => Promise<DbOrder>;

    onOrderStatusResponse: (data: OrderStatusResponse) => Promise<void>;

    constructor(settings: Settings) {
        this.settings = settings;
    }

    async createOrder(data) {
        try {
            const order = await this.onCreateOrder(data);
            await this.send('order_response', {success: order});
        } catch (error) {
            log.error(error);
            await this.send('order_response', {error: error.message});
        }
    }

    async cancelOrder(data) {
        try {
            const order = await this.onCancelOrder(data);
            await this.send('cancel_order_response', {success: order});
        } catch (error) {
            log.error(error);
            await this.send('cancel_order_response', {error: error.message});
        }
    }

    connect(): Promise<void> {
        return Promise.resolve()
        // return new Promise((resolve, reject) => {
        //     if (this.stomp) {
        //         this.disconnect();
        //     }
        //
        //     const brokerId = '1';
        //     const password = 'password is not used by now';
        //
        //     log.log('Try to connect hub ws', this.settings.orionUrl);
        //
        //     this.socket = new SockJS(this.settings.orionUrl);
        //     this.stomp = Stomp.over(this.socket);
        //     this.stomp.connect(brokerId, password, (frame) => {
        //         log.log('Connected to hub ws:', frame);
        //
        //         this.stomp.subscribe('/order', async (data) => {
        //             try {
        //                 const order = await this.onCreateOrder(data);
        //                 await this.send('order_response', {success: order});
        //             } catch (error) {
        //                 log.error(error);
        //                 await this.send('order_response', {error: error.message});
        //             }
        //         });
        //
        //         this.stomp.subscribe('/cancel_order', async (data) => {
        //             try {
        //                 const order = await this.onCancelOrder(data);
        //                 await this.send('cancel_order_response', {success: order});
        //             } catch (error) {
        //                 log.error(error);
        //                 await this.send('cancel_order_response', {error: error.message});
        //             }
        //         });
        //
        //         resolve();
        //     });
        // });
    }

    disconnect(): Promise<void> {
        return Promise.resolve()
    }

    private async send(method: string, data: any): Promise<void> {
        // try {
        //     this.stomp.send(method, {}, JSON.stringify(data));
        // } catch (e) {
        //     log.error(e);
        // }
    }

    async register(data: BrokerHubRegisterRequest): Promise<void> {
        await this.send('register', data);
    }

    async sendBalances(data: any): Promise<void> {
        await this.send('balance', data);
    }

    async sendTrade(data: TradeRequest): Promise<void> {
        await this.send('order_status', data);
    }
}

