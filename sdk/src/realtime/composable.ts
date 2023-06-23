import type { DirectusClient } from '../client.js';
import type { SubscribeOptions, WebSocketClient, WebSocketConfig } from './types.js';
import { messageCallback } from './utils/message-callback.js';
import { generateUid } from './utils/generate-uid.js';
import { pong } from './commands/pong.js';
import { auth } from './commands/auth.js';

/**
 * Creates a client to communicate with a Directus REST WebSocket.
 *
 * @param config The optional configuration.
 *
 * @returns A Directus realtime client.
 */
export function realtime(config: WebSocketConfig = { authMode: 'handshake' }) {
	return <Schema extends object>(client: DirectusClient<Schema>) => {
		let socket: globalThis.WebSocket | null = null;
		let uid = generateUid();

		const withStrictAuth = async (url: URL) => {
			if (config.authMode === 'strict') {
				const token = await client.getToken();
				if (token) url.searchParams.set('access_token', token);
			}

			return url;
		};

		const getSocketUrl = async () => {
			if ('url' in config) return await withStrictAuth(new URL(config.url));

			// if the main URL is a websocket URL use it directly!
			if (['ws:', 'wss:'].includes(client.url.protocol)) {
				return await withStrictAuth(client.url);
			}

			// try filling in the defaults based on the main URL
			const newUrl = new URL(client.url.toString());
			newUrl.protocol = client.url.protocol === 'https:' ? 'wss:' : 'ws:';
			newUrl.pathname = '/websocket';

			return await withStrictAuth(newUrl);
		};

		const resetConnection = () => {
			socket = null;
			uid = generateUid();
			// TODO reconnecting strategy
		};

		const handleMessages = async (ws: globalThis.WebSocket) => {
			while (ws.readyState !== WebSocket.CLOSED) {
				const message = await messageCallback(ws);

				if ('type' in message && message['type'] === 'auth') {
					const access_token = await client.getToken();
					if (access_token) ws.send(auth({ access_token }));
				}

				if ('type' in message && message['type'] === 'ping') {
					ws.send(pong());
				}
			}
		};

		return {
			async connect() {
				const url = await getSocketUrl();
				return new Promise<void>((resolve, reject) => {
					let resolved = false;
					const ws = new globalThis.WebSocket(url);

					ws.addEventListener('open', async () => {
						if (config.authMode === 'handshake') {
							const access_token = await client.getToken();

							if (access_token) ws.send(auth({ access_token }));
						}

						resolved = true;
						handleMessages(ws);
						resolve();
					});

					ws.addEventListener('error', (evt) => {
						resetConnection();
						if (!resolved) reject(evt);
					});

					ws.addEventListener('close', (evt) => {
						resetConnection();
						if (!resolved) reject(evt);
					});

					socket = ws;
				});
			},
			disconnect() {
				if (socket && socket?.readyState === WebSocket.OPEN) {
					socket.close();
				}

				socket = null;
			},
			message(message: Record<string, any>) {
				if (!socket || socket?.readyState !== WebSocket.OPEN) {
					// TODO use directus error
					throw new Error('websocket connection not OPEN');
				}

				if ('uid' in message === false) {
					message['uid'] = uid.next().value;
				}

				socket?.send(JSON.stringify(message));
			},
			receive(callback: (message: Record<string, any>) => any) {
				if (!socket || socket?.readyState !== WebSocket.OPEN) {
					// TODO use directus error
					throw new Error('websocket connection not OPEN');
				}

				const handler = (data: MessageEvent<string>) => {
					try {
						const message = JSON.parse(data.data) as Record<string, any>;

						if (typeof message === 'object' && !Array.isArray(message) && message !== null) {
							callback(message);
						}
					} catch (err) {
						// @TODO: either ignore or throw proper error
						// eslint-disable-next-line no-console
						console.warn('invalid message', err);
					}
				};

				socket.addEventListener('message', handler);
				return () => socket?.removeEventListener('message', handler);
			},
			async subscribe<Collection extends keyof Schema, Options extends SubscribeOptions<Schema, Collection>>(
				collection: Collection,
				options: Options = {} as Options
			) {
				if (!socket || socket.readyState !== WebSocket.OPEN) await this.connect();
				if ('uid' in options === false) options.uid = uid.next().value;

				let subscribed = true;
				const ws = socket!;
				const send = (obj: Record<string, any>) => ws.send(JSON.stringify(obj));

				send({ ...options, collection, type: 'subscribe' });

				async function* subscriptionGenerator() {
					while (subscribed && socket && socket.readyState === WebSocket.OPEN) {
						const message = await messageCallback(socket);

						if ('type' in message && message['type'] === 'subscription' && message['uid'] === options.uid) {
							yield message;
						}
					}
				}

				return {
					subscription: subscriptionGenerator(),
					unsubscribe() {
						send({ uid: options.uid, type: 'unsubscribe' });
						subscribed = false;
					},
				};
			},
		} as WebSocketClient<Schema>;
	};
}
