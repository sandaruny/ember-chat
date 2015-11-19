

//// Logging
//Strophe.log = function (level, msg) { console.log(level+' '+msg, level); };
//Strophe.error = function (msg) { console.log(msg, 'error'); };
//
//// Add Strophe Namespaces
//Strophe.addNamespace('CARBONS', 'urn:xmpp:carbons:2');
//Strophe.addNamespace('CHATSTATES', 'http://jabber.org/protocol/chatstates');
//Strophe.addNamespace('CSI', 'urn:xmpp:csi:0');
//Strophe.addNamespace('MAM', 'urn:xmpp:mam:0');
//Strophe.addNamespace('MUC_ADMIN', Strophe.NS.MUC + "#admin");
//Strophe.addNamespace('MUC_OWNER', Strophe.NS.MUC + "#owner");
//Strophe.addNamespace('MUC_REGISTER', "jabber:iq:register");
//Strophe.addNamespace('MUC_ROOMCONF', Strophe.NS.MUC + "#roomconfig");
//Strophe.addNamespace('MUC_USER', Strophe.NS.MUC + "#user");
//Strophe.addNamespace('REGISTER', 'jabber:iq:register');
//Strophe.addNamespace('ROSTERX', 'http://jabber.org/protocol/rosterx');
//Strophe.addNamespace('RSM', 'http://jabber.org/protocol/rsm');
//Strophe.addNamespace('XFORM', 'jabber:x:data');

// Add Strophe Statuses
//var i = 0;
//Object.keys(Strophe.Status).forEach(function (key) {
//  i = Math.max(i, Strophe.Status[key]);
//});
//Strophe.Status.REGIFAIL        = i + 1;
//Strophe.Status.REGISTERED      = i + 2;
//Strophe.Status.CONFLICT        = i + 3;
//Strophe.Status.NOTACCEPTABLE   = i + 5;

// Constants
// ---------
export var LOGIN = "login";
export var  ANONYMOUS  = "anonymous";
export var PREBIND = "prebind";

export var UNENCRYPTED = 0;
export var UNVERIFIED= 1;
export var VERIFIED= 2;
export var FINISHED = 3;
export var KEY = {
  ENTER: 13,
  FORWARD_SLASH: 47
};

var PRETTY_CONNECTION_STATUS = {
  0: 'ERROR',
  1: 'CONNECTING',
  2: 'CONNFAIL',
  3: 'AUTHENTICATING',
  4: 'AUTHFAIL',
  5: 'CONNECTED',
  6: 'DISCONNECTED',
  7: 'DISCONNECTING',
  8: 'ATTACHED',
  9: 'REDIRECT'
};

// XEP-0085 Chat states
// http://xmpp.org/extensions/xep-0085.html
var INACTIVE = 'inactive';
var ACTIVE = 'active';
var COMPOSING = 'composing';
var PAUSED = 'paused';
var GONE = 'gone';
var TIMEOUTS = { // Set as module attr so that we can override in tests.
  'PAUSED':     20000,
  'INACTIVE':   90000
};
var HAS_CSPRNG = ((typeof crypto !== 'undefined') &&
((typeof crypto.randomBytes === 'function') ||
  (typeof crypto.getRandomValues === 'function')
));
var HAS_CRYPTO = HAS_CSPRNG && (
    (typeof CryptoJS !== "undefined") &&
    (typeof OTR !== "undefined") &&
    (typeof DSA !== "undefined")
  );
var OPENED = 'opened';
var CLOSED = 'closed';
