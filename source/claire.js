// Claire

'use strict';

// a mapping of tab IDs to requests
var requests = {};

// listen to all web requests and when request is completed, create a new
// Request object that contains a bunch of information about the request

var processCompletedRequest = function(details) {
    var request = new Request(details);
    requests[details.tabId] = request;
    request.logToConsole();
};

var filter = {
    urls: ['<all_urls>'],
    types: ['main_frame']
};

var extraInfoSpec = ['responseHeaders'];

// start listening to all web requests
chrome.webRequest.onCompleted.addListener(processCompletedRequest, filter, extraInfoSpec);

// when a tab is replaced, usually when a request started in a background tab
// and then the tab is upgraded to a regular tab (becomes visible)
chrome.tabs.onReplaced.addListener(function(addedTabId, removedTabId) {
    if (removedTabId in requests) {
        requests[addedTabId] = requests[removedTabId];
        delete requests[removedTabId];
    } else {
        console.log('could not find an entry in requests for ', removedTabId);
    }

});

chrome.webNavigation.onDOMContentLoaded.addListener(function(details) {
    if (details.frameId > 0) {
        // we don't care about sub-frame requests
        return;
    }

    if (details.tabId in requests) {
        var request = requests[details.tabId];
        request.querySPDYStatusAndSetIcon();
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    var request = requests[sender.tab.id];
    if (request) {
        request.setSPDYStatus(request.spdy);
    }
    sendResponse({});
});

// clear request data when tabs are destroyed
chrome.tabs.onRemoved.addListener(function(tabId, removeInfo) { delete requests[tabId]; });

// the Request object, contains information about a request
var Request = function(details) {
    this.details = details;
    this.headersRaw = details.responseHeaders;

    // headers will be stored as name: value pairs (all names will be upper case)
    this.headers = {};

    // weather the request object knows about the SPDY status or not
    // this status is available in the context of the page, requires message passing
    // from the extension to the page
    this.hasSPDYStatus = false;

    this.preProcessHeaders();
};

// convert the headers array into an object and upcase all names
// (warning! will preserve only last of multiple headers with same name)
Request.prototype.preProcessHeaders = function() {
    this.headersRaw.forEach(function(header) {
        this.headers[header.name.toUpperCase()] = header.value;
    }, this);

    if ('CF-RAILGUN' in this.headers) {
        this.processRailgunHeader();
    }

};

Request.prototype.processRailgunHeader = function() {

    var railgunHeader = this.headers['CF-RAILGUN'];

    this.railgunMetaData = {};

    if (!(typeof railgunHeader === 'string')) {
        return this.railgunMetaData;
    }

    // Railgun header can be in one of two formats
    // one of them will have the string "normal"
    var railgunNormal = (railgunHeader.indexOf('normal') !== -1);

    var parts = railgunHeader.split(' ');

    var flagsBitset = 0;

    this.railgunMetaData['normal'] = railgunNormal;
    this.railgunMetaData['id'] = parts[0];
    if (railgunNormal) {
        flagsBitset = parseInt(parts[1], 10);
        this.railgunMetaData['version'] = parts[3];
    } else {
        this.railgunMetaData['compression'] = (100 - parts[1]) + '%';
        this.railgunMetaData['time'] = parts[2] + 'sec';
        flagsBitset = parseInt(parts[3], 10);
        this.railgunMetaData['version'] = parts[4];
    }

    // decode the flags bitest
    var railgunFlags = {
        FLAG_DOMAIN_MAP_USED: {
            position: 0x01,
            message: 'map.file used to change IP'
        },
        FLAG_DEFAULT_IP_USED: {
            position: 0x02,
            message: 'map.file default IP used'
        },
        FLAG_HOST_CHANGE: {
            position: 0x04,
            message: 'Host name change'
        },
        FLAG_REUSED_CONNECTION: {
            position: 0x08,
            message: 'Existing connection reused'
        },
        FLAG_HAD_DICTIONARY: {
            position: 0x10,
            message: 'Railgun sender sent dictionary'
        },
        FLAG_WAS_CACHED: {
            position: 0x20,
            message: 'Dictionary found in memcache'
        },
        FLAG_RESTART_CONNECTION: {
            position: 0x40,
            message: 'Restarted broken origin connection'
        }
    };

    var messages = [];

    for(var flagKey in railgunFlags) {
        var flag = railgunFlags[flagKey];
        if ((flagsBitset & flag.position) !== 0) {
            messages.push(flag.message);
        }
    }

    this.railgunMetaData['flags'] = flagsBitset;
    this.railgunMetaData['messages'] = messages;

};

Request.prototype.querySPDYStatusAndSetIcon = function() {
    var tabID = this.details.tabId;
    if (this.hasSPDYStatus) {
        this.setPageActionIconAndPopup();
    } else {
        var cs_message_data = {'action': 'check_spdy_status'};
        var cs_message_callback = function(cs_msg_response) {
            // stop and return if we don't get a response, happens with hidden/background tabs
            if (typeof cs_msg_response === 'undefined') return;

            var request = requests[tabID];
            request.SPDY = cs_msg_response.spdy;
            request.setPageActionIconAndPopup();
        }
        try {
            chrome.tabs.sendMessage(this.details.tabId, cs_message_data, cs_message_callback);
        } catch (e) {
            console.log('caught exception when sending message to content script');
            console.log(chrome.extension.lastError());
            console.log(e);
        }
    }
};

// check if the server header matches 'cloudflare-nginx'
Request.prototype.servedByCloudFlare = function() {
    return ('SERVER' in this.headers) && (this.headers.SERVER === 'cloudflare-nginx');
};

Request.prototype.servedByRailgun = function() {
    return ('CF-RAILGUN' in this.headers);
};

Request.prototype.servedOverSPDY = function() {
    return this.SPDY;
};

Request.prototype.ServedFromBrowserCache = function() {
    return this.details.fromCache;
};

Request.prototype.getRayID = function() {
    return this.headers['CF-RAY'];
};

Request.prototype.getTabID = function() {
    return this.details.tabId;
};

Request.prototype.getRequestURL = function() {
    return this.details.url;
};

Request.prototype.getRailgunMetaData = function() {
    return this.railgunMetaData;
};

Request.prototype.getServerIP = function() {
    return this.details.ip;
};

Request.prototype.isv6IP = function() {
    return (this.getServerIP().indexOf(':') !== -1);
};

// figure out what the page action should be based on the
// features we detected in this request
Request.prototype.getPageActionPath = function() {
    var iconPath = 'images/claire-3-';
    var iconPathParts = [];

    if (this.servedByCloudFlare()) {
        iconPathParts.push('on')
    } else {
        iconPathParts.push('off');
    }

    if (this.servedOverSPDY()) {
        iconPathParts.push('spdy');
    }

    if (this.isv6IP()) {
        iconPathParts.push('ipv6');
    }

    if (this.servedByRailgun()) {
        iconPathParts.push('rg');
    }

    return iconPath + iconPathParts.join('-') + '.png';
};

Request.prototype.setSPDYStatus = function(status) {
    this.hasSPDYStatus = true;
    this.SPDY = status;
};

Request.prototype.setPageActionIconAndPopup = function() {
    var iconPath = this.getPageActionPath();
    var tabID = this.details.tabId;
    chrome.pageAction.setIcon({
        tabId: this.details.tabId,
        path: iconPath
    }, function() {
        try {
            chrome.pageAction.setPopup({'tabId': tabID, 'popup': 'page_action_popup.html'});
            chrome.pageAction.show(tabID);
        } catch (e) {
            console.log('Exception on page action show for tab with ID: ', tabID, e);
        }
    });
};

Request.prototype.logToConsole = function() {
    if (localStorage.getItem('debug_logging') !== 'yes') {
        return;
    }

    console.log('\n');
    console.log(this.details.url, this.details.ip, 'CF - ' + this.servedByCloudFlare());
    console.log('Request - ', this.details);
    if (this.servedByCloudFlare()) {
        console.log('Ray ID - ', this.getRayID());
    }
    if (this.servedByRailgun()) {
        var railgunMetaData = this.getRailgunMetaData();
        console.log('Railgun - ', railgunMetaData['id'], railgunMetaData.messages.join('; '));
    }
};