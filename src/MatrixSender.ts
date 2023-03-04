import { BridgeConfig } from "./Config/Config";
import { MessageQueue, createMessageQueue } from "./MessageQueue";
import { Appservice } from "matrix-bot-sdk";
import { Logger } from "matrix-appservice-bridge";
import { randomUUID } from 'node:crypto';

export interface IMatrixSendMessage {
    sender: string|null;
    type: string;
    roomId: string;
    content: Record<string, unknown>;
}

export interface IMatrixSendStateEvent extends IMatrixSendMessage {
    sender: string|null;
    type: string;
    roomId: string;
    content: Record<string, unknown>;
    stateKey: string;
}

export interface IMatrixSendMessageResponse {
    eventId: string;
}

export interface IMatrixSendMessageFailedResponse {
    failed: boolean;
}

interface SendStateEventArgs {
    roomId: string;
    stateKey: string;
    eventType: string;
    content: unknown;
    sender?: string | null;
}

const log = new Logger("MatrixSender");

export class MatrixSender {
    private mq: MessageQueue;
    constructor(private config: BridgeConfig, private readonly as: Appservice) {
        this.mq = createMessageQueue(this.config.queue);
    }

    public listen() {
        this.mq.subscribe("matrix.message");
        this.mq.on<IMatrixSendMessage>("matrix.message", async (msg) => {
            try {
                await this.sendMatrixMessage(msg.messageId || randomUUID(), msg.data);
            } catch (ex) {
                log.error(`Failed to send message (${msg.data.roomId}, ${msg.data.sender}, ${msg.data.type})`);
            }
        });

        this.mq.subscribe("matrix.state_event");
        this.mq.on<IMatrixSendStateEvent>("matrix.state_event", async (msg) => {
            try {
                await this.sendMatrixStateEvent(msg.messageId || randomUUID(), msg.data);
            } catch (ex) {
                log.error(`Failed to send state event (${msg.data.roomId}, ${msg.data.sender}, ${msg.data.type})`);
            }
        });
    }

    public stop() {
        if (this.mq.stop) {
            this.mq.stop();
        }
    }

    public async sendMatrixStateEvent(messageId: string, msg: IMatrixSendStateEvent) {
        const intent = msg.sender ? this.as.getIntentForUserId(msg.sender) : this.as.botIntent;
        await intent.ensureRegisteredAndJoined(msg.roomId);

        try {
            const eventId =await intent.underlyingClient.sendStateEvent(msg.roomId, msg.type, msg.stateKey, msg.content);
                log.info(`Sent state event to room ${msg.roomId} (${msg.sender}) > ${eventId}`);
                await this.mq.push<IMatrixSendMessageResponse>({
                    eventName: "response.matrix.message",
                    sender: "MatrixSender",
                    data: {
                        eventId,
                    },
                    messageId,
                });
        } catch (ex) {
            await this.mq.push<IMatrixSendMessageFailedResponse>({
                eventName: "response.matrix.message",
                sender: "MatrixSender",
                data: {
                    failed: true,
                },
                messageId,
            });
        }
    }

    public async sendMatrixMessage(messageId: string, msg: IMatrixSendMessage) {
        const intent = msg.sender ? this.as.getIntentForUserId(msg.sender) : this.as.botIntent;
        if (this.config.encryption) {
            // Ensure crypto is aware of all members of this room before posting any messages,
            // so that the bot can share room keys to all recipients first.
            await intent.enableEncryption();
            await intent.joinRoom(msg.roomId);
            await intent.underlyingClient.crypto.onRoomJoin(msg.roomId);
        } else {
            await intent.ensureRegisteredAndJoined(msg.roomId);
        }
        try {
                const eventId = this.shouldEncrypt(msg.content?.msgtype as string)
                    ? await intent.underlyingClient.sendEvent(msg.roomId, msg.type, msg.content)
                    : await intent.underlyingClient.sendRawEvent(msg.roomId, msg.type, msg.content);
                log.info(`Sent event to room ${msg.roomId} (${msg.sender}) > ${eventId}`);
                await this.mq.push<IMatrixSendMessageResponse>({
                    eventName: "response.matrix.message",
                    sender: "MatrixSender",
                    data: {
                        eventId,
                    },
                    messageId,
                });
        } catch (ex) {
            await this.mq.push<IMatrixSendMessageFailedResponse>({
                eventName: "response.matrix.message",
                sender: "MatrixSender",
                data: {
                    failed: true,
                },
                messageId,
            });
        }
    }

    private shouldEncrypt(msgType: string | undefined): boolean {
        return msgType !== "m.notice" || (this.config.encryption?.encryptNotices ?? true);
    }
}

export class MessageSenderClient {
    constructor(private queue: MessageQueue) { }

    public async sendMatrixText(roomId: string, text: string, msgtype = "m.text",
                                sender: string|null = null): Promise<string> {
        return this.sendMatrixMessage(roomId, {
            msgtype,
            body: text,
        }, "m.room.message", sender);
    }

    public async sendMatrixStateEvent({
        roomId,
        eventType,
        content,
        stateKey = "",
        sender = null,
    }: SendStateEventArgs): Promise<string> {
        const result = await this.queue.pushWait<IMatrixSendStateEvent, IMatrixSendMessageResponse|IMatrixSendMessageFailedResponse>({
            eventName: "matrix.state_event",
            sender: "Bridge",
            data: {
                roomId,
                type: eventType,
                stateKey,
                sender,
                content: content as Record<string, undefined>,
            },
        });

        if ("eventId" in result) {
            return result.eventId;
        }

        throw Error('Failed to send Matrix state event');
    }

    public async sendMatrixMessage(
        roomId: string,
        content: unknown,
        eventType = "m.room.message",
        sender: string|null = null,
    ): Promise<string> {
        const result = await this.queue.pushWait<IMatrixSendMessage, IMatrixSendMessageResponse|IMatrixSendMessageFailedResponse>({
            eventName: "matrix.message",
            sender: "Bridge",
            data: {
                roomId,
                type: eventType,
                sender,
                content: content as Record<string, undefined>,
            },
        });

        if ("eventId" in result) {
            return result.eventId;
        }

        throw Error('Failed to send Matrix message');
    }
}
