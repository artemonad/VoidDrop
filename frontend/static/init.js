(function() {
    // Hook Object.getOwnPropertyDescriptor to prevent Svelte 5 hydration / DOM getter crashes
    var originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    var nodeFirstChildDesc = originalGetOwnPropertyDescriptor(Node.prototype, 'firstChild');
    var nodeNextSiblingDesc = originalGetOwnPropertyDescriptor(Node.prototype, 'nextSibling');
    var nativeFirstChildGet = nodeFirstChildDesc ? nodeFirstChildDesc.get : null;
    var nativeNextSiblingGet = nodeNextSiblingDesc ? nodeNextSiblingDesc.get : null;

    Object.getOwnPropertyDescriptor = function(obj, prop) {
        try {
            var desc = originalGetOwnPropertyDescriptor.apply(this, arguments);
            if (obj === Node.prototype && (prop === 'firstChild' || prop === 'nextSibling')) {
                var nativeGet = prop === 'firstChild' ? nativeFirstChildGet : nativeNextSiblingGet;
                if (nativeGet && (!desc || typeof desc.get !== 'function')) {
                    return {
                        get: function() {
                            return nativeGet.call(this);
                        },
                        set: desc ? desc.set : undefined,
                        enumerable: desc ? desc.enumerable : true,
                        configurable: desc ? desc.configurable : true
                    };
                }
            }
            return desc;
        } catch (e) {
            return originalGetOwnPropertyDescriptor.apply(this, arguments);
        }
    };

    var originalFetch = window.fetch;
    window.__nativeFetch = originalFetch;
    var sveltekitFetch = null;
    
    Object.defineProperty(window, 'fetch', {
        get: function() {
            if (!sveltekitFetch) {
                return originalFetch;
            }
            return function(resource, init) {
                var isIpc = false;
                var urlStr = '';
                if (typeof resource === 'string') {
                    urlStr = resource;
                } else if (resource && typeof resource === 'object' && 'url' in resource && typeof resource.url === 'string') {
                    urlStr = resource.url;
                } else if (resource && typeof resource.toString === 'function') {
                    urlStr = resource.toString();
                }
                
                if (urlStr) {
                    if (/^[a-z0-9+-.]+:/i.test(urlStr) && !urlStr.startsWith('http:') && !urlStr.startsWith('https:')) {
                        isIpc = true;
                    } else if (urlStr.includes('ipc.localhost') || urlStr.includes('tauri.localhost') || urlStr.includes('__tauri')) {
                        isIpc = true;
                    }
                }
                
                if (isIpc) {
                    return originalFetch(resource, init);
                }
                
                return sveltekitFetch(resource, init);
            };
        },
        set: function(val) {
            sveltekitFetch = val;
        },
        configurable: true,
        enumerable: true
    });
})();
