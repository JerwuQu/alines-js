import { createServer } from 'net'; // https://nodejs.org/api/net.html

class BufferStream {
	constructor() {
		this.closed = false;
		this.buf = [];
		this.update = null;
	}
	async get(n) {
		if (this.closed) {
			throw 'stream source closed';
		} else if (this.update) {
			throw 'already waiting';
		}
		if (n <= this.buf.length) {
			const bf = this.buf.slice(0, n);
			this.buf = this.buf.slice(n);
			return bf;
		} else {
			return new Promise((accept, reject) => {
				this.update = () => {
					if (this.closed) {
						this.update = null;
						reject();
					} else if (n <= this.buf.length) {
						const bf = this.buf.slice(0, n);
						this.buf = this.buf.slice(n);
						this.update = null;
						accept(bf);
					}
				};
			});
		}
	}
	push(data) {
		this.buf.push(...data);
		if (this.update) {
			this.update();
		}
	}
	close() {
		this.closed = true;
		if (this.update) {
			this.update();
		}
	}
}

const clients = new Set();
let activeMenu = null;
let server = null;

const u16Enc = num => {
	return [Math.floor(num / 256), num % 256];
};
const u16StrEnc = str => {
	const buf = Buffer.from(str, 'utf8');
	return [...u16Enc(buf.length), ...buf];
};
const u16Dec = async reader => {
	const buf = await reader.get(2);
	return (buf[0] * 256) | (buf[1] % 256);
};
const u16StrDec = async reader => {
	const len = await u16Dec(reader);
	return Buffer.from(await reader.get(len)).toString();
};

const clientDisconnect = (client, msg) => {
	console.log('client forcefully disconnected:', msg);
	clients.delete(client);
	client.write(new Uint8Array([0, ...u16StrEnc(msg)]), null, () => client.destroy());
};

const clientOpenMenu = client => {
	console.log('sending menu to client');
	const m = activeMenu;
	const data = [
		1,
		(m.options?.allowMulti ? 1 : 0) | (m.options?.allowCustom ? 2 : 0),
		...u16Enc(m.entries.length),
		...u16Enc((m.options?.selectedIndex ?? -1) + 1),
		...u16StrEnc(m.title),
	];
	for (let entry of m.entries) {
		data.push(...u16StrEnc(entry));
	}
	client.write(new Uint8Array(data));
};

const clientCloseMenu = client => {
	console.log('sending close to client');
	client.write(new Uint8Array([2]));
};

const API = {
	startServer: (password, port) => {
		if (server) {
			throw 'Server already running';
		}
		server = createServer(client => {
			console.log('client connected');
			const reader = new BufferStream();
			client.on('error', () => clientDisconnect(client, 'connection error'));
			client.on('end', () => clientDisconnect(client, 'connection closed'));
			client.on('close', () => {
				console.log('client disconnect');
				clients.delete(client);
				reader.close();
			});
			client.on('data', data => reader.push(data));
			let connected = false;
			(async () => {
				try {
					while (true) {
						if (connected) {
							const packetId = (await reader.get(1))[0];
							if (!activeMenu) {
								clientDisconnect(client, 'response despite no menu');
								break;
							}
							if (packetId === 0) { // Close/No Selection
								clients.forEach(c => c !== client ? clientCloseMenu(c) : 0);
								activeMenu.resolve(null);
								activeMenu = null;
							} else if (packetId === 1) { // Single Selection
								const resp = activeMenu.entries[await u16Dec(reader)];
								clients.forEach(c => c !== client ? clientCloseMenu(c) : 0);
								activeMenu.resolve(resp);
								activeMenu = null;
							} else if (packetId === 2) { // Multi Selection
								const len = await u16Dec(reader);
								const resp = new Array(len).fill().map(async () => activeMenu.entries[await u16Dec(reader)]);
								clients.forEach(c => c !== client ? clientCloseMenu(c) : 0);
								activeMenu.resolve(resp);
								activeMenu = null;
							} else if (packetId === 3) { // Custom Entry
								const resp = await u16StrDec(reader);
								clients.forEach(c => c !== client ? clientCloseMenu(c) : 0);
								activeMenu.resolve(resp);
								activeMenu = null;
							} else {
								clientDisconnect(client, 'unsupported packet ' + packetId);
								break;
							}
						} else {
							const pass = await u16StrDec(reader);
							if (!password || password === pass) {
								console.log('client accepted');
								connected = true;
								if (activeMenu) {
									clientOpenMenu(client);
								}
								clients.add(client);
							} else {
								clientDisconnect(client, 'invalid password');
								break;
							}
						}
					}
				} catch(ex) {
					console.error(ex);
				}
			})();
		});
		server.on('error', err => console.error('server error', err));
		server.listen(port ?? 64937, () => console.log('listening'));
	},
	stopServer: () => {
		if (server) {
			console.log('server closed');
			clients.forEach(client => clientDisconnect(client, 'server closing'));
			clients.clear();
			server.close();
			server.unref();
			server = null;
		}
	},
	openMenu: async (title, entries, options) => {
		return new Promise(resolve => {
			console.log('menu open (' + entries.length + ' entries)');
			if (activeMenu) {
				API.closeMenu();
				activeMenu = null;
			}
			activeMenu = {title, entries, options, resolve};
			clients.forEach(clientOpenMenu);
		});
	},
	closeMenu: () => {
		console.log('menu close');
		if (!activeMenu) {
			return;
		}
		activeMenu.resolve(null);
		activeMenu = null;
		clients.forEach(clientCloseMenu);
	},
};

export default API;
