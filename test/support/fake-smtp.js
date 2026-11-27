import net from 'node:net';

/**
 * In-process SMTP server on 127.0.0.1 for tests: speaks enough ESMTP for
 * srv/lib/notifications/smtp-client.js (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT)
 * and records every accepted message. No mail ever leaves the machine.
 *
 * failNext(stage, reply, times) makes the next `times` occurrences of a stage
 * ('CONNECT' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'MESSAGE') answer with `reply`.
 */
export async function startFakeSmtp({ users = { 'mailer@example.com': 'secret' }, authMechanisms = 'PLAIN LOGIN', startTls = false } = {}) {
    const messages = [];
    const failures = new Map();
    const stats = { connections: 0, authenticated: [] };

    const takeFailure = (stage) => {
        const queue = failures.get(stage);
        return queue?.length ? queue.shift() : null;
    };

    const server = net.createServer((socket) => {
        stats.connections++;
        const send = (line) => socket.write(`${line}\r\n`);
        const connectFailure = takeFailure('CONNECT');
        if (connectFailure) {
            send(connectFailure);
            socket.end();
            return;
        }
        send('220 fake.smtp.test ESMTP ready');

        let buffer = '';
        let mode = 'command'; // command | data | auth-login-user | auth-login-pass
        let loginUser = null;
        let user = null;
        let envelope = { from: null, to: [] };
        let data = [];

        const login = (name, password) => {
            if (users[name] !== undefined && users[name] === password) {
                user = name;
                stats.authenticated.push(name);
                send('235 2.7.0 Authentication successful');
            } else send('535 5.7.8 Authentication credentials invalid');
        };

        const onLine = (line) => {
            if (mode === 'data') {
                if (line === '.') {
                    mode = 'command';
                    const failure = takeFailure('MESSAGE');
                    if (failure) return send(failure);
                    messages.push({ ...envelope, user, raw: data.join('\r\n') });
                    envelope = { from: null, to: [] };
                    return send(`250 2.0.0 OK queued as fake-${messages.length}`);
                }
                data.push(line.startsWith('..') ? line.slice(1) : line);
                return;
            }
            if (mode === 'auth-login-user') {
                loginUser = Buffer.from(line, 'base64').toString('utf8');
                mode = 'auth-login-pass';
                return send('334 UGFzc3dvcmQ6');
            }
            if (mode === 'auth-login-pass') {
                mode = 'command';
                return login(loginUser, Buffer.from(line, 'base64').toString('utf8'));
            }

            const [verb] = line.split(' ');
            switch (verb.toUpperCase()) {
                case 'EHLO':
                    send('250-fake.smtp.test');
                    if (startTls) send('250-STARTTLS');
                    if (authMechanisms) send(`250-AUTH ${authMechanisms}`);
                    return send('250 8BITMIME');
                case 'AUTH': {
                    const failure = takeFailure('AUTH');
                    if (failure) return send(failure);
                    const [, mechanism, initial] = line.split(' ');
                    if (mechanism.toUpperCase() === 'PLAIN') {
                        const [, name, password] = Buffer.from(initial ?? '', 'base64').toString('utf8').split('\0');
                        return login(name, password);
                    }
                    if (mechanism.toUpperCase() === 'LOGIN') {
                        mode = 'auth-login-user';
                        return send('334 VXNlcm5hbWU6');
                    }
                    return send('504 5.5.4 Unrecognized authentication type');
                }
                case 'MAIL': {
                    const failure = takeFailure('MAIL');
                    if (failure) return send(failure);
                    if (Object.keys(users).length && !user) return send('530 5.7.0 Authentication required');
                    envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? null;
                    return send('250 2.1.0 OK');
                }
                case 'RCPT': {
                    const failure = takeFailure('RCPT');
                    if (failure) return send(failure);
                    envelope.to.push(/<([^>]*)>/.exec(line)?.[1]);
                    return send('250 2.1.5 OK');
                }
                case 'DATA': {
                    const failure = takeFailure('DATA');
                    if (failure) return send(failure);
                    mode = 'data';
                    data = [];
                    return send('354 End data with <CR><LF>.<CR><LF>');
                }
                case 'QUIT':
                    send('221 2.0.0 Bye');
                    return socket.end();
                default:
                    return send('502 5.5.2 Command not implemented');
            }
        };

        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let i;
            while ((i = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, i);
                buffer = buffer.slice(i + 2);
                onLine(line);
            }
        });
        socket.on('error', () => {});
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        port: server.address().port,
        messages,
        stats,
        failNext(stage, reply, times = 1) {
            const queue = failures.get(stage) ?? [];
            for (let i = 0; i < times; i++) queue.push(reply);
            failures.set(stage, queue);
        },
        reset() {
            messages.length = 0;
            failures.clear();
        },
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

/** Headers and decoded text / HTML parts of a message built by srv/lib/notifications/mime.js. */
export function parseMail(raw) {
    const [head, ...rest] = raw.split('\r\n\r\n');
    const headers = {};
    for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
        const i = line.indexOf(':');
        headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    const decodeWords = (value) => value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
    const body = rest.join('\r\n\r\n');
    const part = (type) => {
        const m = new RegExp(`Content-Type: ${type}[^\\r]*\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`).exec(body);
        return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : null;
    };
    return { headers, subject: decodeWords(headers.subject ?? ''), text: part('text/plain'), html: part('text/html') };
}
