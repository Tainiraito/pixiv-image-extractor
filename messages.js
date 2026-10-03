// Locale-independent messages shared by popup, content script and download services.
globalThis.PixivMessages = Object.freeze({
    make(messageKey, messageParams = {}) { return { messageKey, messageParams, message: '' }; },
    error(messageKey, messageParams = {}) {
        return Object.assign(new Error(messageKey), { messageKey, messageParams });
    },
    describe(error, fallback = 'error.unknown') {
        if (error?.messageKey) return this.make(error.messageKey, error.messageParams || {});
        const detail = String(error?.message || error?.error || '').trim().slice(0, 240);
        return detail ? this.make('error.external', { detail }) : this.make(fallback);
    },
    fromResponse(response, fallback = 'error.background') {
        if (response?.messageKey) return this.error(response.messageKey, response.messageParams || {});
        return response?.error ? new Error(response.error) : this.error(fallback);
    }
});
