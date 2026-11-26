import { google } from 'googleapis';

/**
 * Thin, read-only wrapper around the Gmail API (googleapis). Only these four calls are
 * used; nothing sends, modifies, labels, archives, deletes or marks messages as read.
 * Tests replace the factory with a fake (setGmailClientFactory) - no real Gmail access.
 *
 * @typedef {object} GmailClient
 * @property {() => Promise<{emailAddress:string}>} getProfile
 * @property {(q:string, pageToken?:string) => Promise<{ids:string[], nextPageToken:string|null}>} listMessageIds
 * @property {(id:string) => Promise<object>} getMessage            users.messages.get, format=full
 * @property {(messageId:string, attachmentId:string) => Promise<Buffer>} getAttachment
 */

function googleGmailClient(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    return {
        async getProfile() {
            const { data } = await gmail.users.getProfile({ userId: 'me' });
            return { emailAddress: data.emailAddress };
        },
        async listMessageIds(q, pageToken) {
            const { data } = await gmail.users.messages.list({ userId: 'me', q, pageToken, maxResults: 100, includeSpamTrash: false });
            return { ids: (data.messages ?? []).map((m) => m.id), nextPageToken: data.nextPageToken ?? null };
        },
        async getMessage(id) {
            const { data } = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
            return data;
        },
        async getAttachment(messageId, attachmentId) {
            const { data } = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
            return Buffer.from(String(data.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        },
    };
}

let factory = googleGmailClient;

/** @returns {GmailClient} */
export function createGmailClient(auth) {
    return factory(auth);
}

/** Test hook: replace the client factory (pass null to restore the Google implementation). */
export function setGmailClientFactory(fn) {
    factory = fn ?? googleGmailClient;
}
