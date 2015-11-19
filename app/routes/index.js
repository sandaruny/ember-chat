import Ember from 'ember';
import tawasul2 from 'converse-api/tawasul2';
import TO from 'converse-api/tawasul-objects';


// Use Mustache style syntax for variable interpolation
/* Configuration of underscore templates (this config is distinct to the
 * config of requirejs-tpl in main.js). This one is for normal inline templates.
 */
_.templateSettings = {
  evaluate : /\{\[([\s\S]+?)\]\}/g,
  interpolate : /\{\{([\s\S]+?)\}\}/g
};

var contains = function (attr, query) {
  return function (item) {
    if (typeof attr === 'object') {
      var value = false;
      _.each(attr, function (a) {
        value = value || item.get(a).toLowerCase().indexOf(query.toLowerCase()) !== -1;
      });
      return value;
    } else if (typeof attr === 'string') {
      return item.get(attr).toLowerCase().indexOf(query.toLowerCase()) !== -1;
    } else {
      throw new TypeError('contains: wrong attribute type. Must be string or array.');
    }
  };
};
contains.not = function (attr, query) {
  return function (item) {
    return !(contains(attr, query)(item));
  };
};

var converse = {
  plugins: {},
  templates: templates,
  emit: function (evt, data) {
    $(this).trigger(evt, data);
  },
  once: function (evt, handler) {
    $(this).one(evt, handler);
  },
  on: function (evt, handler) {
    $(this).bind(evt, handler);
  },
  off: function (evt, handler) {
    $(this).unbind(evt, handler);
  },
  refreshWebkit: function () {
    /* This works around a webkit bug. Refresh the browser's viewport,
     * otherwise chatboxes are not moved along when one is closed.
     */
    if ($.browser.webkit) {
      var conversejs = document.getElementById('conversejs');
      conversejs.style.display = 'none';
      conversejs.offsetHeight = conversejs.offsetHeight;
      conversejs.style.display = 'block';
    }
  }
};

// Global constants

// XEP-0059 Result Set Management
var RSM_ATTRIBUTES = ['max', 'first', 'last', 'after', 'before', 'index', 'count'];
// XEP-0313 Message Archive Management
var MAM_ATTRIBUTES = ['with', 'start', 'end'];

var STATUS_WEIGHTS = {
  'offline':      6,
  'unavailable':  5,
  'xa':           4,
  'away':         3,
  'dnd':          2,
  'chat':         1, // We currently don't differentiate between "chat" and "online"
  'online':       1
};

converse.initialize = function (settings, callback) {
  "use strict";
  var converse = this;
  var unloadevent;
  if ('onpagehide' in window) {
    // Pagehide gets thrown in more cases than unload. Specifically it
    // gets thrown when the page is cached and not just
    // closed/destroyed. It's the only viable event on mobile Safari.
    // https://www.webkit.org/blog/516/webkit-page-cache-ii-the-unload-event/
    unloadevent = 'pagehide';
  } else if ('onbeforeunload' in window) {
    unloadevent = 'beforeunload';
  } else if ('onunload' in window) {
    unloadevent = 'unload';
  }

  // Logging
  Strophe.log = function (level, msg) { console.log(level+' '+msg, level); };
  Strophe.error = function (msg) { console.log(msg, 'error'); };

  // Add Strophe Namespaces
  Strophe.addNamespace('CARBONS', 'urn:xmpp:carbons:2');
  Strophe.addNamespace('CHATSTATES', 'http://jabber.org/protocol/chatstates');
  Strophe.addNamespace('CSI', 'urn:xmpp:csi:0');
  Strophe.addNamespace('MAM', 'urn:xmpp:mam:0');
  Strophe.addNamespace('MUC_ADMIN', Strophe.NS.MUC + "#admin");
  Strophe.addNamespace('MUC_OWNER', Strophe.NS.MUC + "#owner");
  Strophe.addNamespace('MUC_REGISTER', "jabber:iq:register");
  Strophe.addNamespace('MUC_ROOMCONF', Strophe.NS.MUC + "#roomconfig");
  Strophe.addNamespace('MUC_USER', Strophe.NS.MUC + "#user");
  Strophe.addNamespace('REGISTER', 'jabber:iq:register');
  Strophe.addNamespace('ROSTERX', 'http://jabber.org/protocol/rosterx');
  Strophe.addNamespace('RSM', 'http://jabber.org/protocol/rsm');
  Strophe.addNamespace('XFORM', 'jabber:x:data');

  // Add Strophe Statuses
  var i = 0;
  Object.keys(Strophe.Status).forEach(function (key) {
    i = Math.max(i, Strophe.Status[key]);
  });
  Strophe.Status.REGIFAIL        = i + 1;
  Strophe.Status.REGISTERED      = i + 2;
  Strophe.Status.CONFLICT        = i + 3;
  Strophe.Status.NOTACCEPTABLE   = i + 5;

  // Constants
  // ---------
  var LOGIN = "login";
  var ANONYMOUS  = "anonymous";
  var PREBIND = "prebind";

  var UNENCRYPTED = 0;
  var UNVERIFIED= 1;
  var VERIFIED= 2;
  var FINISHED = 3;
  var KEY = {
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
  this.TIMEOUTS = { // Set as module attr so that we can override in tests.
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

  // Detect support for the user's locale
  // ------------------------------------
  this.isConverseLocale = function (locale) { return typeof locales[locale] !== "undefined"; };
  this.isMomentLocale = function (locale) { return moment.locale() !== moment.locale(locale); };

  this.isLocaleAvailable = function (locale, available) {
    /* Check whether the locale or sub locale (e.g. en-US, en) is supported.
     *
     * Parameters:
     *      (Function) available - returns a boolean indicating whether the locale is supported
     */
    if (available(locale)) {
      return locale;
    } else {
      var sublocale = locale.split("-")[0];
      if (sublocale !== locale && available(sublocale)) {
        return sublocale;
      }
    }
  };

  this.detectLocale = function (library_check) {
    /* Determine which locale is supported by the user's system as well
     * as by the relevant library (e.g. converse.js or moment.js).
     *
     * Parameters:
     *      (Function) library_check - returns a boolean indicating whether the locale is supported
     */
    var locale, i;
    if (window.navigator.userLanguage) {
      locale = this.isLocaleAvailable(window.navigator.userLanguage, library_check);
    }
    if (window.navigator.languages && !locale) {
      for (i=0; i<window.navigator.languages.length && !locale; i++) {
        locale = this.isLocaleAvailable(window.navigator.languages[i], library_check);
      }
    }
    if (window.navigator.browserLanguage && !locale) {
      locale = this.isLocaleAvailable(window.navigator.browserLanguage, library_check);
    }
    if (window.navigator.language && !locale) {
      locale = this.isLocaleAvailable(window.navigator.language, library_check);
    }
    if (window.navigator.systemLanguage && !locale) {
      locale = this.isLocaleAvailable(window.navigator.systemLanguage, library_check);
    }
    return locale || 'en';
  };

  if (!moment.locale) { //moment.lang is deprecated after 2.8.1, use moment.locale instead
    moment.locale = moment.lang;
  }
  moment.locale(this.detectLocale(this.isMomentLocale));
  this.i18n = settings.i18n ? settings.i18n : locales[this.detectLocale(this.isConverseLocale)];

  // Translation machinery
  // ---------------------
  var __ = utils.__.bind(this);
  var ___ = utils.___;

  // Default configuration values
  // ----------------------------
  this.default_settings = {
    allow_chat_pending_contacts: false,
    allow_contact_removal: true,
    allow_contact_requests: true,
    allow_dragresize: true,
    allow_logout: true,
    allow_muc: true,
    allow_otr: true,
    archived_messages_page_size: '20',
    auto_away: 0, // Seconds after which user status is set to 'away'
    auto_xa: 0, // Seconds after which user status is set to 'xa'
    allow_registration: true,
    animate: true,
    auto_list_rooms: false,
    auto_login: false, // Currently only used in connection with anonymous login
    auto_reconnect: false,
    auto_subscribe: false,
    bosh_service_url: undefined, // The BOSH connection manager URL.
    cache_otr_key: false,
    csi_waiting_time: 0, // Support for XEP-0352. Seconds before client is considered idle and CSI is sent out.
    debug: false,
    domain_placeholder: __(" e.g. conversejs.org"),  // Placeholder text shown in the domain input on the registration form
    expose_rid_and_sid: false,
    forward_messages: false,
    hide_muc_server: false,
    hide_offline_users: false,
    jid: undefined,
    keepalive: false,
    message_archiving: 'never', // Supported values are 'always', 'never', 'roster' (See https://xmpp.org/extensions/xep-0313.html#prefs )
    message_carbons: false, // Support for XEP-280
    muc_history_max_stanzas: undefined, // Takes an integer, limits the amount of messages to fetch from chat room's history
    no_trimming: false, // Set to true for phantomjs tests (where browser apparently has no width)
    ping_interval: 180, //in seconds
    play_sounds: false,
    sounds_path: '/sounds/',
    password: undefined,
    authentication: 'login', // Available values are "login", "prebind", "anonymous".
    prebind: false, // XXX: Deprecated, use "authentication" instead.
    prebind_url: null,
    providers_link: 'https://xmpp.net/directory.php', // Link to XMPP providers shown on registration page
    rid: undefined,
    roster_groups: false,
    show_controlbox_by_default: false,
    show_only_online_users: false,
    show_toolbar: true,
    sid: undefined,
    storage: 'session',
    use_otr_by_default: false,
    use_vcards: true,
    visible_toolbar_buttons: {
      'emoticons': true,
      'call': false,
      'clear': true,
      'toggle_occupants': true
    },
    websocket_url: undefined,
    xhr_custom_status: false,
    xhr_custom_status_url: '',
    xhr_user_search: false,
    xhr_user_search_url: ''
  };

  _.extend(this, this.default_settings);
  // Allow only whitelisted configuration attributes to be overwritten
  _.extend(this, _.pick(settings, Object.keys(this.default_settings)));

  // BBB
  if (this.prebind === true) { this.authentication = PREBIND; }

  if (this.authentication === ANONYMOUS) {
    if (!this.jid) {
      throw("Config Error: you need to provide the server's domain via the " +
      "'jid' option when using anonymous authentication.");
    }
  }

  if (settings.visible_toolbar_buttons) {
    _.extend(
      this.visible_toolbar_buttons,
      _.pick(settings.visible_toolbar_buttons, [
          'emoticons', 'call', 'clear', 'toggle_occupants'
        ]
      ));
  }
  $.fx.off = !this.animate;

  // Only allow OTR if we have the capability
  this.allow_otr = this.allow_otr && HAS_CRYPTO;

  // Only use OTR by default if allow OTR is enabled to begin with
  this.use_otr_by_default = this.use_otr_by_default && this.allow_otr;

  // Translation aware constants
  // ---------------------------
  var OTR_CLASS_MAPPING = {};
  OTR_CLASS_MAPPING[UNENCRYPTED] = 'unencrypted';
  OTR_CLASS_MAPPING[UNVERIFIED] = 'unverified';
  OTR_CLASS_MAPPING[VERIFIED] = 'verified';
  OTR_CLASS_MAPPING[FINISHED] = 'finished';

  var OTR_TRANSLATED_MAPPING  = {};
  OTR_TRANSLATED_MAPPING[UNENCRYPTED] = __('unencrypted');
  OTR_TRANSLATED_MAPPING[UNVERIFIED] = __('unverified');
  OTR_TRANSLATED_MAPPING[VERIFIED] = __('verified');
  OTR_TRANSLATED_MAPPING[FINISHED] = __('finished');

  var STATUSES = {
    'dnd': __('This contact is busy'),
    'online': __('This contact is online'),
    'offline': __('This contact is offline'),
    'unavailable': __('This contact is unavailable'),
    'xa': __('This contact is away for an extended period'),
    'away': __('This contact is away')
  };
  var DESC_GROUP_TOGGLE = __('Click to hide these contacts');

  var HEADER_CURRENT_CONTACTS =  __('My contacts');
  var HEADER_PENDING_CONTACTS = __('Pending contacts');
  var HEADER_REQUESTING_CONTACTS = __('Contact requests');
  var HEADER_UNGROUPED = __('Ungrouped');

  var LABEL_CONTACTS = __('Contacts');
  var LABEL_GROUPS = __('Groups');

  var HEADER_WEIGHTS = {};
  HEADER_WEIGHTS[HEADER_CURRENT_CONTACTS]    = 0;
  HEADER_WEIGHTS[HEADER_UNGROUPED]           = 1;
  HEADER_WEIGHTS[HEADER_REQUESTING_CONTACTS] = 2;
  HEADER_WEIGHTS[HEADER_PENDING_CONTACTS]    = 3;

  // Module-level variables
  // ----------------------
  this.callback = callback || function () {};
  this.initial_presence_sent = 0;
  this.msg_counter = 0;

  // Module-level functions
  // ----------------------

  this.sendCSI = function (stat) {
    /* Send out a Chat Status Notification (XEP-0352) */
    if (converse.features[Strophe.NS.CSI] || true) {
      converse.connection.send($build(stat, {xmlns: Strophe.NS.CSI}));
      this.inactive = (stat === INACTIVE) ? true : false;
    }
  };

  this.onUserActivity = function () {
    /* Resets counters and flags relating to CSI and auto_away/auto_xa */
    if (this.idle_seconds > 0) {
      this.idle_seconds = 0;
    }
    if (!converse.connection.authenticated) {
      // We can't send out any stanzas when there's no authenticated connection.
      // This can happen when the connection reconnects.
      return;
    }
    if (this.inactive) {
      this.sendCSI(ACTIVE);
    }
    if (this.auto_changed_status === true) {
      this.auto_changed_status = false;
      this.xmppstatus.setStatus('online');
    }
  };

  this.onEverySecond = function () {
    /* An interval handler running every second.
     * Used for CSI and the auto_away and auto_xa
     * features.
     */
    if (!converse.connection.authenticated) {
      // We can't send out any stanzas when there's no authenticated connection.
      // This can happen when the connection reconnects.
      return;
    }
    var stat = this.xmppstatus.getStatus();
    this.idle_seconds++;
    if (this.csi_waiting_time > 0 && this.idle_seconds > this.csi_waiting_time && !this.inactive) {
      this.sendCSI(INACTIVE);
    }
    if (this.auto_away > 0 && this.idle_seconds > this.auto_away && stat !== 'away' && stat !== 'xa') {
      this.auto_changed_status = true;
      this.xmppstatus.setStatus('away');
    } else if (this.auto_xa > 0 && this.idle_seconds > this.auto_xa && stat !== 'xa') {
      this.auto_changed_status = true;
      this.xmppstatus.setStatus('xa');
    }
  };

  this.registerIntervalHandler = function () {
    /* Set an interval of one second and register a handler for it.
     * Required for the auto_away, auto_xa and csi_waiting_time features.
     */
    if (this.auto_away < 1 && this.auto_xa < 1 && this.csi_waiting_time < 1) {
      // Waiting time of less then one second means features aren't used.
      return;
    }
    this.idle_seconds = 0;
    this.auto_changed_status = false; // Was the user's status changed by converse.js?
    $(window).on('click mousemove keypress focus'+unloadevent , this.onUserActivity.bind(this));
    window.setInterval(this.onEverySecond.bind(this), 1000);
  };

  this.playNotification = function () {
    var audio;
    if (converse.play_sounds && typeof Audio !== "undefined") {
      audio = new Audio(converse.sounds_path+"msg_received.ogg");
      if (audio.canPlayType('/audio/ogg')) {
        audio.play();
      } else {
        audio = new Audio(converse.sounds_path+"msg_received.mp3");
        audio.play();
      }
    }
  };

  this.giveFeedback = function (message, klass) {
    $('.conn-feedback').each(function (idx, el) {
      var $el = $(el);
      $el.addClass('conn-feedback').text(message);
      if (klass) {
        $el.addClass(klass);
      } else {
        $el.removeClass('error');
      }
    });
  };

  this.log = function (txt, level) {
    var logger;
    if (typeof console === "undefined" || typeof console.log === "undefined") {
      logger = { log: function () {}, error: function () {} };
    } else {
      logger = console;
    }
    if (this.debug) {
      if (level === 'error') {
        logger.log('ERROR: '+txt);
      } else {
        logger.log(txt);
      }
    }
  };

  this.rejectPresenceSubscription = function (jid, message) {
    /* Reject or cancel another user's subscription to our presence updates.
     *  Parameters:
     *    (String) jid - The Jabber ID of the user whose subscription
     *      is being canceled.
     *    (String) message - An optional message to the user
     */
    var pres = $pres({to: jid, type: "unsubscribed"});
    if (message && message !== "") { pres.c("status").t(message); }
    converse.connection.send(pres);
  };

  this.getVCard = function (jid, callback, errback) {
    /* Request the VCard of another user.
     *
     * Parameters:
     *    (String) jid - The Jabber ID of the user whose VCard is being requested.
     *    (Function) callback - A function to call once the VCard is returned
     *    (Function) errback - A function to call if an error occured
     *      while trying to fetch the VCard.
     */
    if (!this.use_vcards) {
      if (callback) { callback(jid, jid); }
      return;
    }
    converse.connection.vcard.get(
      function (iq) { // Successful callback
        var $vcard = $(iq).find('vCard');
        var fullname = $vcard.find('FN').text(),
          img = $vcard.find('BINVAL').text(),
          img_type = $vcard.find('TYPE').text(),
          url = $vcard.find('URL').text();
        if (jid) {
          var contact = converse.roster.get(jid);
          if (contact) {
            fullname = _.isEmpty(fullname)? contact.get('fullname') || jid: fullname;
            contact.save({
              'fullname': fullname,
              'image_type': img_type,
              'image': img,
              'url': url,
              'vcard_updated': moment().format()
            });
          }
        }
        if (callback) { callback(iq, jid, fullname, img, img_type, url); }
      }.bind(this),
      jid,
      function (iq) { // Error callback
        var contact = converse.roster.get(jid);
        if (contact) {
          contact.save({ 'vcard_updated': moment().format() });
        }
        if (errback) { errback(iq, jid); }
      }
    );
  };

  this.reconnect = function (condition) {
    console.log('Attempting to reconnect in 5 seconds');
    converse.giveFeedback(__('Attempting to reconnect in 5 seconds'), 'error');
    setTimeout(function () {
      if (converse.authentication !== "prebind") {
        this.connection.connect(
          this.connection.jid,
          this.connection.pass,
          function (status, condition) {
            this.onConnectStatusChanged(status, condition, true);
          }.bind(this),
          this.connection.wait,
          this.connection.hold,
          this.connection.route
        );
      } else if (converse.prebind_url) {
        this.clearSession();
        this._tearDown();
        this.startNewBOSHSession();
      }
    }.bind(this), 5000);
  };

  this.renderLoginPanel = function () {
    converse._tearDown();
    var view = converse.chatboxviews.get('controlbox');
    view.model.set({connected:false});
    view.renderLoginPanel();
  };

  this.onConnectStatusChanged = function (status, condition, reconnect) {
    console.log("Status changed to: "+PRETTY_CONNECTION_STATUS[status]);
    if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
      delete converse.disconnection_cause;
      if ((typeof reconnect !== 'undefined') && (reconnect)) {
        console.log(status === Strophe.Status.CONNECTED ? 'Reconnected' : 'Reattached');
        converse.onReconnected();
      } else {
        console.log(status === Strophe.Status.CONNECTED ? 'Connected' : 'Attached');
        converse.onConnected();
      }
    } else if (status === Strophe.Status.DISCONNECTED) {
      if (converse.disconnection_cause === Strophe.Status.CONNFAIL && converse.auto_reconnect) {
        converse.reconnect(condition);
      } else {
        converse.renderLoginPanel();
      }
    } else if (status === Strophe.Status.ERROR) {
      converse.giveFeedback(__('Error'), 'error');
    } else if (status === Strophe.Status.CONNECTING) {
      converse.giveFeedback(__('Connecting'));
    } else if (status === Strophe.Status.AUTHENTICATING) {
      converse.giveFeedback(__('Authenticating'));
    } else if (status === Strophe.Status.AUTHFAIL) {
      converse.giveFeedback(__('Authentication Failed'), 'error');
      converse.connection.disconnect(__('Authentication Failed'));
      converse.disconnection_cause = Strophe.Status.AUTHFAIL;
    } else if (status === Strophe.Status.CONNFAIL) {
      converse.disconnection_cause = Strophe.Status.CONNFAIL;
    } else if (status === Strophe.Status.DISCONNECTING) {
      // FIXME: what about prebind?
      if (!converse.connection.connected) {
        converse.renderLoginPanel();
      }
      if (condition) {
        converse.giveFeedback(condition, 'error');
      }
    }
  };

  this.applyDragResistance = function (value, default_value) {
    /* This method applies some resistance around the
     * default_value. If value is close enough to
     * default_value, then default_value is returned instead.
     */
    if (typeof value === 'undefined') {
      return undefined;
    } else if (typeof default_value === 'undefined') {
      return value;
    }
    var resistance = 10;
    if ((value !== default_value) &&
      (Math.abs(value- default_value) < resistance)) {
      return default_value;
    }
    return value;
  };

  this.updateMsgCounter = function () {
    if (this.msg_counter > 0) {
      if (document.title.search(/^Messages \(\d+\) /) === -1) {
        document.title = "Messages (" + this.msg_counter + ") " + document.title;
      } else {
        document.title = document.title.replace(/^Messages \(\d+\) /, "Messages (" + this.msg_counter + ") ");
      }
      window.blur();
      window.focus();
    } else if (document.title.search(/^Messages \(\d+\) /) !== -1) {
      document.title = document.title.replace(/^Messages \(\d+\) /, "");
    }
  };

  this.incrementMsgCounter = function () {
    this.msg_counter += 1;
    this.updateMsgCounter();
  };

  this.clearMsgCounter = function () {
    this.msg_counter = 0;
    this.updateMsgCounter();
  };

  this.initStatus = function (callback) {
    //this.xmppstatus = new this.XMPPStatus();
    //var id = b64_sha1('converse.xmppstatus-'+converse.bare_jid);
    //this.xmppstatus.id = id; // Appears to be necessary for backbone.browserStorage
    //this.xmppstatus.browserStorage = new Backbone.BrowserStorage[converse.storage](id);
    //this.xmppstatus.fetch({success: callback, error: callback});
  };

  this.initSession = function () {
    //this.session = new this.Session();
    //var id = b64_sha1('converse.bosh-session');
    //this.session.id = id; // Appears to be necessary for backbone.browserStorage
    //this.session.browserStorage = new Backbone.BrowserStorage[converse.storage](id);
    //this.session.fetch();
  };

  this.clearSession = function () {
    if (this.roster) {
      this.roster.browserStorage._clear();
    }
    this.session.browserStorage._clear();
    if (converse.connection.connected) {
      converse.chatboxes.get('controlbox').save({'connected': false});
    }
  };

  this.logOut = function () {
    //converse.chatboxviews.closeAllChatBoxes(false);
    converse.clearSession();
    converse.connection.disconnect();
  };

  this.registerGlobalEventHandlers = function () {
    $(document).click(function () {
      if ($('.toggle-otr ul').is(':visible')) {
        $('.toggle-otr ul', this).slideUp();
      }
      if ($('.toggle-smiley ul').is(':visible')) {
        $('.toggle-smiley ul', this).slideUp();
      }
    });

    $(document).on('mousemove', function (ev) {
      if (!this.resizing || !this.allow_dragresize) { return true; }
      ev.preventDefault();
      this.resizing.chatbox.resizeChatBox(ev);
    }.bind(this));

    $(document).on('mouseup', function (ev) {
      if (!this.resizing || !this.allow_dragresize) { return true; }
      ev.preventDefault();
      var height = this.applyDragResistance(
        this.resizing.chatbox.height,
        this.resizing.chatbox.model.get('default_height')
      );
      var width = this.applyDragResistance(
        this.resizing.chatbox.width,
        this.resizing.chatbox.model.get('default_width')
      );
      if (this.connection.connected) {
        this.resizing.chatbox.model.save({'height': height});
        this.resizing.chatbox.model.save({'width': width});
      } else {
        this.resizing.chatbox.model.set({'height': height});
        this.resizing.chatbox.model.set({'width': width});
      }
      this.resizing = null;
    }.bind(this));

    $(window).on("blur focus", function (ev) {
      if ((this.windowState !== ev.type) && (ev.type === 'focus')) {
        converse.clearMsgCounter();
      }
      this.windowState = ev.type;
    }.bind(this));

    $(window).on("resize", _.debounce(function (ev) {
      //this.chatboxviews.trimChats();
    }.bind(this), 200));
  };

  this.ping = function (jid, success, error, timeout) {
    // XXX: We could first check here if the server advertised that it supports PING.
    // However, some servers don't advertise while still keeping the
    // connection option due to pings.
    //
    // var feature = converse.features.findWhere({'var': Strophe.NS.PING});
    converse.lastStanzaDate = new Date();
    if (typeof jid === 'undefined' || jid === null) {
      jid = Strophe.getDomainFromJid(converse.bare_jid);
    }
    if (typeof timeout === 'undefined' ) { timeout = null; }
    if (typeof success === 'undefined' ) { success = null; }
    if (typeof error === 'undefined' ) { error = null; }
    if (converse.connection) {
      converse.connection.ping.ping(jid, success, error, timeout);
      return true;
    }
    return false;
  };

  this.pong = function (ping) {
    converse.lastStanzaDate = new Date();
    converse.connection.ping.pong(ping);
    return true;
  };

  this.registerPongHandler = function () {
    converse.connection.disco.addFeature(Strophe.NS.PING);
    converse.connection.ping.addPingHandler(this.pong);
  };

  this.registerPingHandler = function () {
    this.registerPongHandler();
    if (this.ping_interval > 0) {
      this.connection.addHandler(function () {
        /* Handler on each stanza, saves the received date
         * in order to ping only when needed.
         */
        this.lastStanzaDate = new Date();
        return true;
      }.bind(converse));
      this.connection.addTimedHandler(1000, function () {
        var now = new Date();
        if (!this.lastStanzaDate) {
          this.lastStanzaDate = now;
        }
        if ((now - this.lastStanzaDate)/1000 > this.ping_interval) {
          return this.ping();
        }
        return true;
      }.bind(converse));
    }
  };

  this.onReconnected = function () {
    // We need to re-register all the event handlers on the newly
    // created connection.
    this.initStatus(function () {
      this.registerPingHandler();
      //this.rosterview.registerRosterXHandler();
      //this.rosterview.registerPresenceHandler();
      //this.chatboxes.registerMessageHandler();
      //this.xmppstatus.sendPresence();
      this.giveFeedback(__('Contacts'));
    }.bind(this));
  };

  this.enableCarbons = function () {
    /* Ask the XMPP server to enable Message Carbons
     * See XEP-0280 https://xmpp.org/extensions/xep-0280.html#enabling
     */
    if (!this.message_carbons || this.session.get('carbons_enabled')) {
      return;
    }
    var carbons_iq = new Strophe.Builder('iq', {
      from: this.connection.jid,
      id: 'enablecarbons',
      type: 'set'
    })
      .c('enable', {xmlns: Strophe.NS.CARBONS});
    this.connection.addHandler(function (iq) {
      if ($(iq).find('error').length > 0) {
        console.log('ERROR: An error occured while trying to enable message carbons.');
      } else {
        this.session.save({carbons_enabled: true});
        console.log('Message carbons have been enabled.');
      }
    }.bind(this), null, "iq", null, "enablecarbons");
    this.connection.send(carbons_iq);
  };

  this.onConnected = function () {
    // When reconnecting, there might be some open chat boxes. We don't
    // know whether these boxes are of the same account or not, so we
    // close them now.
    // this.chatboxviews.closeAllChatBoxes();
    this.jid = this.connection.jid;
    this.bare_jid = Strophe.getBareJidFromJid(this.connection.jid);
    this.resource = Strophe.getResourceFromJid(this.connection.jid);
    this.domain = Strophe.getDomainFromJid(this.connection.jid);
    this.minimized_chats = new converse.MinimizedChats({model: this.chatboxes});
    // this.features = new this.Features();
    this.enableCarbons();
    this.initStatus(function () {
      this.registerPingHandler();
      this.registerIntervalHandler();
      //this.chatboxes.onConnected();
      this.giveFeedback(__('Contacts'));
      if (this.callback) {
        if (this.connection.service === 'jasmine tests') {
          // XXX: Call back with the internal converse object. This
          // object should never be exposed to production systems.
          // 'jasmine tests' is an invalid http bind service value,
          // so we're sure that this is just for tests.
          this.callback(this);
        } else  {
          this.callback();
        }
      }
    }.bind(this));
    converse.emit('ready');
  };

  // BackBone Models


  this.addControlBox = function () {
    //return this.chatboxes.add({
    //  id: 'controlbox',
    //  box_id: 'controlbox',
    //  closed: !this.show_controlbox_by_default
    //});
  };

  this.setUpXMLLogging = function () {
    if (this.debug) {
      this.connection.xmlInput = function (body) { console.log(body); };
      this.connection.xmlOutput = function (body) { console.log(body); };
    }
  };

  this.startNewBOSHSession = function () {
    $.ajax({
      url:  this.prebind_url,
      type: 'GET',
      success: function (response) {
        this.connection.attach(
          response.jid,
          response.sid,
          response.rid,
          this.onConnectStatusChanged
        );
      }.bind(this),
      error: function (response) {
        delete this.connection;
        this.emit('noResumeableSession');
      }.bind(this)
    });
  };

  this.attemptPreboundSession = function (tokens) {
    /* Handle session resumption or initialization when prebind is being used.
     */
    if (this.keepalive) {
      if (!this.jid) {
        throw new Error("initConnection: when using 'keepalive' with 'prebind, you must supply the JID of the current user.");
      }
      try {
        return this.connection.restore(this.jid, this.onConnectStatusChanged);
      } catch (e) {
        console.log("Could not restore session for jid: "+this.jid+" Error message: "+e.message);
      }
    } else { // Not keepalive
      if (this.jid && this.sid && this.rid) {
        return this.connection.attach(this.jid, this.sid, this.rid, this.onConnectStatusChanged);
      } else {
        throw new Error("initConnection: If you use prebind and not keepalive, "+
          "then you MUST supply JID, RID and SID values");
      }
    }
    // We haven't been able to attach yet. Let's see if there
    // is a prebind_url, otherwise there's nothing with which
    // we can attach.
    if (this.prebind_url) {
      this.startNewBOSHSession();
    } else {
      delete this.connection;
      this.emit('noResumeableSession');
    }
  };

  this.attemptNonPreboundSession = function () {
    /* Handle session resumption or initialization when prebind is not being used.
     *
     * Two potential options exist and are handled in this method:
     *  1. keepalive
     *  2. auto_login
     */
    if (this.keepalive) {
      try {
        return this.connection.restore(undefined, this.onConnectStatusChanged);
      } catch (e) {
        console.log("Could not restore sessions. Error message: "+e.message);
      }
    }
    if (this.auto_login) {
      if (!this.jid) {
        throw new Error("initConnection: If you use auto_login, you also need to provide a jid value");
      }
      if (this.authentication === ANONYMOUS) {
        this.connection.connect(this.jid.toLowerCase(), null, this.onConnectStatusChanged);
      } else if (this.authentication === LOGIN) {
        if (!this.password) {
          throw new Error("initConnection: If you use auto_login and "+
            "authentication='login' then you also need to provide a password.");
        }
        this.jid = Strophe.getBareJidFromJid(this.jid).toLowerCase()+'/'+Strophe.getResourceFromJid(this.jid);
        this.connection.connect(this.jid, this.password, this.onConnectStatusChanged);
      }
    }
  };

  this.initConnection = function () {
    if (this.connection && this.connection.connected) {
      this.setUpXMLLogging();
      this.onConnected();
    } else {
      if (!this.bosh_service_url && ! this.websocket_url) {
        throw new Error("initConnection: you must supply a value for either the bosh_service_url or websocket_url or both.");
      }
      if (('WebSocket' in window || 'MozWebSocket' in window) && this.websocket_url) {
        this.connection = new Strophe.Connection(this.websocket_url);
      } else if (this.bosh_service_url) {
        this.connection = new Strophe.Connection(this.bosh_service_url, {'keepalive': this.keepalive});
      } else {
        throw new Error("initConnection: this browser does not support websockets and bosh_service_url wasn't specified.");
      }
      this.setUpXMLLogging();
      // We now try to resume or automatically set up a new session.
      // Otherwise the user will be shown a login form.
      if (this.authentication === PREBIND) {
        this.attemptPreboundSession();
      } else {
        this.attemptNonPreboundSession();
      }
    }
  };

  this._tearDown = function () {
    /* Remove those views which are only allowed with a valid
     * connection.
     */
    this.initial_presence_sent = false;
    if (this.roster) {
      this.roster.off().reset(); // Removes roster contacts
    }
    if (this.rosterview) {
      this.rosterview.unregisterHandlers();
      this.rosterview.model.off().reset(); // Removes roster groups
      this.rosterview.undelegateEvents().remove();
    }
    this.chatboxes.remove(); // Don't call off(), events won't get re-registered upon reconnect.
    if (this.features) {
      this.features.reset();
    }
    if (this.minimized_chats) {
      this.minimized_chats.undelegateEvents().model.reset();
      this.minimized_chats.removeAll(); // Remove sub-views
      this.minimized_chats.tearDown().remove(); // Remove overview
      delete this.minimized_chats;
    }
    return this;
  };

  this._initialize = function () {
    //this.chatboxes = new this.ChatBoxes();
    //this.chatboxviews = new this.ChatBoxViews({model: this.chatboxes});
    //this.controlboxtoggle = new this.ControlBoxToggle();
    //this.otr = new this.OTR();
    this.initSession();
    this.initConnection();
    if (this.connection) {
      this.addControlBox();
    }
    return this;
  };

  this._overrideAttribute = function (key, plugin) {
    // See converse.plugins.override
    var value = plugin.overrides[key];
    if (typeof value === "function") {
      if (typeof plugin._super === "undefined") {
        plugin._super = {'converse': converse};
      }
      plugin._super[key] = converse[key].bind(converse);
      converse[key] = value.bind(plugin);
    } else {
      converse[key] = value;
    }
  };

  this._extendObject = function (obj, attributes) {
    // See converse.plugins.extend
    if (!obj.prototype._super) {
      obj.prototype._super = {'converse': converse};
    }
    _.each(attributes, function (value, key) {
      if (key === 'events') {
        obj.prototype[key] = _.extend(value, obj.prototype[key]);
      } else {
        if (typeof value === 'function') {
          obj.prototype._super[key] = obj.prototype[key];
        }
        obj.prototype[key] = value;
      }
    });
  };

  this._initializePlugins = function () {
    _.each(this.plugins, function (plugin) {
      plugin.converse = converse;
      _.each(Object.keys(plugin.overrides), function (key) {
        /* We automatically override all methods and Backbone views and
         * models that are in the "overrides" namespace.
         */
        var override = plugin.overrides[key];
        if (typeof override === "object") {
          this._extendObject(converse[key], override);
        } else {
          this._overrideAttribute(key, plugin);
        }
      }.bind(this));

      if (typeof plugin.initialize === "function") {
        plugin.initialize.bind(plugin)(this);
      } else {
        // This will be deprecated in 0.10
        plugin.bind(this)(this);
      }
    }.bind(this));
  };

  // Initialization
  // --------------
  // This is the end of the initialize method.
  if (settings.connection) {
    this.connection = settings.connection;
  }
  this._initializePlugins();
  this._initialize();
  this.registerGlobalEventHandlers();
  converse.emit('initialized');
};

var wrappedChatBox = function (chatbox) {
  if (!chatbox) { return; }
  var view = converse.chatboxviews.get(chatbox.get('jid'));
  return {
    'close': view.close.bind(view),
    'endOTR': chatbox.endOTR.bind(chatbox),
    'focus': view.focus.bind(view),
    'get': chatbox.get.bind(chatbox),
    'initiateOTR': chatbox.initiateOTR.bind(chatbox),
    'is_chatroom': chatbox.is_chatroom,
    'maximize': chatbox.maximize.bind(chatbox),
    'minimize': chatbox.minimize.bind(chatbox),
    'open': view.show.bind(view),
    'set': chatbox.set.bind(chatbox)
  };
};


var roster = Ember.Object.create({

  onRosterPush:function (iq) {
    /* Handle roster updates from the XMPP server.
     * See: https://xmpp.org/rfcs/rfc6121.html#roster-syntax-actions-push
     *
     * Parameters:
     *    (XMLElement) IQ - The IQ stanza received from the XMPP server.
     */

    alert('on roster push '+iq);
    var id = iq.getAttribute('id');
    var from = iq.getAttribute('from');


    if (from && from !== "" && Strophe.getBareJidFromJid(from) !== converse.bare_jid) {
      // Receiving client MUST ignore stanza unless it has no from or from = user's bare JID.
      // XXX: Some naughty servers apparently send from a full
      // JID so we need to explicitly compare bare jids here.
      // https://github.com/jcbrand/converse.js/issues/493
      converse.connection.send(
        $iq({type: 'error', id: id, from: converse.connection.jid})
          .c('error', {'type': 'cancel'})
          .c('service-unavailable', {'xmlns': Strophe.NS.ROSTER })
      );
      return true;
    }
    converse.connection.send($iq({type: 'result', id: id, from: converse.connection.jid}));
    $(iq).children('query').find('item').each(function (idx, item) {
      this.updateContact(item);
    }.bind(this));

    converse.emit('rosterPush', iq);
    return true;
  },

  registerRosterHandler: function () {
    converse.connection.addHandler(
      roster.onRosterPush.bind(roster),
      Strophe.NS.ROSTER, 'iq', "set"
    );
  },

  registerRosterXHandler: function () {
    var t = 0;
    converse.connection.addHandler(
      function (msg) {
        alert('rosterx handler');

        window.setTimeout(
          function () {
            converse.connection.flush();
            roster.subscribeToSuggestedItems.bind(roster)(msg);
          },
          t
        );
        t += $(msg).find('item').length*250;
        return true;
      },
      Strophe.NS.ROSTERX, 'message', null
    );
  },

  registerPresenceHandler: function () {
    converse.connection.addHandler(
      function (presence) {
        roster.presenceHandler(presence);
        return true;
      }.bind(this), null, 'presence', null);
  },

  subscribeToSuggestedItems: function (msg) {
    alert('subscribe');
    $(msg).find('item').each(function (i, items) {

      if (this.getAttribute('action') === 'add') {
        converse.roster.addAndSubscribe(
          this.getAttribute('jid'), null, converse.xmppstatus.get('fullname'));
      }
    });
    return true;
  },

  isSelf: function (jid) {
    return (Strophe.getBareJidFromJid(jid) === Strophe.getBareJidFromJid(converse.connection.jid));
  },

  addAndSubscribe: function (jid, name, groups, message, attributes) {

    coverse.log('Add and Subscribe:'+ jid+ ' '+name);
    /* Add a roster contact and then once we have confirmation from
     * the XMPP server we subscribe to that contact's presence updates.
     *  Parameters:
     *    (String) jid - The Jabber ID of the user being added and subscribed to.
     *    (String) name - The name of that user
     *    (Array of Strings) groups - Any roster groups the user might belong to
     *    (String) message - An optional message to explain the
     *      reason for the subscription request.
     *    (Object) attributes - Any additional attributes to be stored on the user's model.
     */
    this.addContact(jid, name, groups, attributes).done(function (contact) {
      if (contact instanceof converse.RosterContact) {
        contact.subscribe(message);
      }
    });
  },

  sendContactAddIQ: function (jid, name, groups, callback, errback) {
    /*  Send an IQ stanza to the XMPP server to add a new roster contact.
     *  Parameters:
     *    (String) jid - The Jabber ID of the user being added
     *    (String) name - The name of that user
     *    (Array of Strings) groups - Any roster groups the user might belong to
     *    (Function) callback - A function to call once the VCard is returned
     *    (Function) errback - A function to call if an error occured
     */
    name = _.isEmpty(name)? jid: name;
    var iq = $iq({type: 'set'})
      .c('query', {xmlns: Strophe.NS.ROSTER})
      .c('item', { jid: jid, name: name });
    _.map(groups, function (group) { iq.c('group').t(group).up(); });
    converse.connection.sendIQ(iq, callback, errback);
  },

  addContact: function (jid, name, groups, attributes) {
    /* Adds a RosterContact instance to converse.roster and
     * registers the contact on the XMPP server.
     * Returns a promise which is resolved once the XMPP server has
     * responded.
     *  Parameters:
     *    (String) jid - The Jabber ID of the user being added and subscribed to.
     *    (String) name - The name of that user
     *    (Array of Strings) groups - Any roster groups the user might belong to
     *    (Object) attributes - Any additional attributes to be stored on the user's model.
     */
    var deferred = new $.Deferred();
    groups = groups || [];
    name = _.isEmpty(name)? jid: name;
    this.sendContactAddIQ(jid, name, groups,
      function (iq) {
        var contact = this.create(_.extend({
          ask: undefined,
          fullname: name,
          groups: groups,
          jid: jid,
          requesting: false,
          subscription: 'none'
        }, attributes), {sort: false});
        deferred.resolve(contact);
      }.bind(this),
      function (err) {
        alert(__("Sorry, there was an error while trying to add "+name+" as a contact."));
        console.log(err);
        deferred.resolve(err);
      }
    );
    return deferred.promise();
  },

  addResource: function (bare_jid, resource) {
    var item = this.get(bare_jid),
      resources;
    if (item) {
      resources = item.get('resources');
      if (resources) {
        if (_.indexOf(resources, resource) === -1) {
          resources.push(resource);
          item.set({'resources': resources});
        }
      } else  {
        item.set({'resources': [resource]});
      }
    }
  },

  subscribeBack: function (bare_jid) {
    var contact = this.get(bare_jid);
    if (contact instanceof converse.RosterContact) {
      contact.authorize().subscribe();
    } else {
      // Can happen when a subscription is retried or roster was deleted
      this.addContact(bare_jid, '', [], { 'subscription': 'from' }).done(function (contact) {
        if (contact instanceof converse.RosterContact) {
          contact.authorize().subscribe();
        }
      });
    }
  },

  getNumOnlineContacts: function () {
    var count = 0,
      ignored = ['offline', 'unavailable'],
      models = this.models,
      models_length = models.length,
      i;
    if (converse.show_only_online_users) {
      ignored = _.union(ignored, ['dnd', 'xa', 'away']);
    }
    for (i=0; i<models_length; i++) {
      if (_.indexOf(ignored, models[i].get('chat_status')) === -1) {
        count++;
      }
    }
    return count;
  },

  fetchFromServer: function (callback, errback) {
    /* Get the roster from the XMPP server */
    var iq = $iq({type: 'get', 'id': converse.connection.getUniqueId('roster')})
      .c('query', {xmlns: Strophe.NS.ROSTER});
    return converse.connection.sendIQ(iq, this.onReceivedFromServer.bind(this));
  },

  onReceivedFromServer: function (iq) {
    /* An IQ stanza containing the roster has been received from
     * the XMPP server.
     */
    converse.emit('roster', iq);
    $(iq).children('query').find('item').each(function (idx, item) {
      this.updateContact(item);
    }.bind(this));
    if (!converse.initial_presence_sent) {
      /* Once we've sent out our initial presence stanza, we'll
       * start receiving presence stanzas from our contacts.
       * We therefore only want to do this after our roster has
       * been set up (otherwise we can't meaningfully process
       * incoming presence stanzas).
       */
      converse.initial_presence_sent = 1;
      converse.xmppstatus.sendPresence();
    }
  },

  updateContact: function (item) {
    /* Update or create RosterContact models based on items
     * received in the IQ from the server.
     */
    var jid = item.getAttribute('jid');
    if (this.isSelf(jid)) { return; }
    var groups = [],
      contact = this.get(jid),
      ask = item.getAttribute("ask"),
      subscription = item.getAttribute("subscription");
    $.map(item.getElementsByTagName('group'), function (group) {
      groups.push(Strophe.getText(group));
    });
    if (!contact) {
      if ((subscription === "none" && ask === null) || (subscription === "remove")) {
        return; // We're lazy when adding contacts.
      }
      this.create({
        ask: ask,
        fullname: item.getAttribute("name") || jid,
        groups: groups,
        jid: jid,
        subscription: subscription
      }, {sort: false});
    } else {
      if (subscription === "remove") {
        return contact.destroy(); // will trigger removeFromRoster
      }
      // We only find out about requesting contacts via the
      // presence handler, so if we receive a contact
      // here, we know they aren't requesting anymore.
      // see docs/DEVELOPER.rst
      contact.save({
        subscription: subscription,
        ask: ask,
        requesting: null,
        groups: groups
      });
    }
  },

  createContactFromVCard: function (iq, jid, fullname, img, img_type, url) {
    var bare_jid = Strophe.getBareJidFromJid(jid);
    this.create({
      jid: bare_jid,
      subscription: 'none',
      ask: null,
      requesting: true,
      fullname: fullname || bare_jid,
      image: img,
      image_type: img_type,
      url: url,
      vcard_updated: moment().format()
    });
  },

  handleIncomingSubscription: function (jid) {
    var bare_jid = Strophe.getBareJidFromJid(jid);
    var contact = this.get(bare_jid);
    if (!converse.allow_contact_requests) {
      converse.rejectPresenceSubscription(jid, __("This client does not allow presence subscriptions"));
    }
    if (converse.auto_subscribe) {
      if ((!contact) || (contact.get('subscription') !== 'to')) {
        this.subscribeBack(bare_jid);
      } else {
        contact.authorize();
      }
    } else {
      if (contact) {
        if (contact.get('subscription') !== 'none')  {
          contact.authorize();
        } else if (contact.get('ask') === "subscribe") {
          contact.authorize();
        }
      } else if (!contact) {
        converse.getVCard(
          bare_jid, this.createContactFromVCard.bind(this),
          function (iq, jid) {
            console.log("Error while retrieving vcard for "+jid);
            this.createContactFromVCard.call(this, iq, jid);
          }.bind(this)
        );
      }
    }
  },

  presenceHandler: function (presence) {
    var $presence = $(presence),
      presence_type = presence.getAttribute('type');
    if (presence_type === 'error') { return true; }
    var jid = presence.getAttribute('from'),
      bare_jid = Strophe.getBareJidFromJid(jid),
      resource = Strophe.getResourceFromJid(jid),
      chat_status = $presence.find('show').text() || 'online',
      status_message = $presence.find('status'),
      contact = this.get(bare_jid);
    if (this.isSelf(bare_jid)) {
      if ((converse.connection.jid !== jid)&&(presence_type !== 'unavailable')) {
        // Another resource has changed its status, we'll update ours as well.
        converse.xmppstatus.save({'status': chat_status});
        if (status_message.length) { converse.xmppstatus.save({'status_message': status_message.text()}); }
      }
      return;
    } else if (($presence.find('x').attr('xmlns') || '').indexOf(Strophe.NS.MUC) === 0) {
      return; // Ignore MUC
    }
    if (contact && (status_message.text() !== contact.get('status'))) {
      contact.save({'status': status_message.text()});
    }
    if (presence_type === 'subscribed' && contact) {
      contact.ackSubscribe();
    } else if (presence_type === 'unsubscribed' && contact) {
      contact.ackUnsubscribe();
    } else if (presence_type === 'unsubscribe') {
      return;
    } else if (presence_type === 'subscribe') {
      this.handleIncomingSubscription(jid);
    } else if (presence_type === 'unavailable' && contact) {
      // Only set the user to offline if there aren't any
      // other resources still available.
      if (contact.removeResource(resource) === 0) {
        contact.save({'chat_status': "offline"});
      }
    } else if (contact) { // presence_type is undefined
      this.addResource(bare_jid, resource);
      contact.save({'chat_status': chat_status});
    }
  }

});


//var registerRosterHandler= function () {
//  converse.connection.addHandler(
//    roster.onRosterPush.bind(roster),
//    Strophe.NS.ROSTER, 'iq', "set"
//  );
//};


//var onRosterPush= function (iq) {
//  /* Handle roster updates from the XMPP server.
//   * See: https://xmpp.org/rfcs/rfc6121.html#roster-syntax-actions-push
//   *
//   * Parameters:
//   *    (XMLElement) IQ - The IQ stanza received from the XMPP server.
//   */
//  var id = iq.getAttribute('id');
//  var from = iq.getAttribute('from');
//  if (from && from !== "" && Strophe.getBareJidFromJid(from) !== converse.bare_jid) {
//    // Receiving client MUST ignore stanza unless it has no from or from = user's bare JID.
//    // XXX: Some naughty servers apparently send from a full
//    // JID so we need to explicitly compare bare jids here.
//    // https://github.com/jcbrand/converse.js/issues/493
//    converse.connection.send(
//      $iq({type: 'error', id: id, from: converse.connection.jid})
//        .c('error', {'type': 'cancel'})
//        .c('service-unavailable', {'xmlns': Strophe.NS.ROSTER })
//    );
//    return true;
//  }
//  converse.connection.send($iq({type: 'result', id: id, from: converse.connection.jid}));
//  $(iq).children('query').find('item').each(function (idx, item) {
//    this.updateContact(item);
//  }.bind(this));
//
//  converse.emit('rosterPush', iq);
//  return true;
//}

//var registerRosterXHandler= function () {
//  var t = 0;
//  converse.connection.addHandler(
//    function (msg) {
//      window.setTimeout(
//        function () {
//          converse.connection.flush();
//          converse.roster.subscribeToSuggestedItems.bind(converse.roster)(msg);
//        },
//        t
//      );
//      t += $(msg).find('item').length*250;
//      return true;
//    },
//    Strophe.NS.ROSTERX, 'message', null
//  );
//};

//var registerPresenceHandler= function () {
//  converse.connection.addHandler(
//    function (presence) {
//      converse.roster.presenceHandler(presence);
//      return true;
//    }.bind(this), null, 'presence', null);
//};

var messageReceive = Ember.Object.create({

  registerMessageHandler : function () {
    converse.connection.addHandler(
      function (message) {
        this.onMessage(message);
        return true;
      }.bind(this), null, 'message', 'chat');

    converse.connection.addHandler(
      function (message) {
        this.onInvite(message);
        return true;
      }.bind(this), 'jabber:x:conference', 'message');
  },

  onMessage: function(message){
    alert('messaged: '+ $(message).html())
  },
  onInvite: function(message){
    alert('messaged: '+ $(message).html())
  }


});

var loadContacts = Ember.Object.create({

  sendIQData: function(){

    var iq = $iq({type: 'get', 'id': converse.connection.getUniqueId('roster')})
             .c('query', {xmlns: Strophe.NS.ROSTER});

    converse.connection.sendIQ(iq, this.onReceivedFromServer.bind(this))

  },

  onReceivedFromServer: function(iq){
    alert('iq '+ $(iq).html() );
  }


});


var initHandlers = function(){
  converse.log('INIT HANDLERS: ')

  roster.registerRosterHandler();
  roster.registerRosterXHandler();
  messageReceive.registerMessageHandler();

  // loadContacts.sendIQData();

}






export default Ember.Route.extend({


  /**
   * Route variables
   */
  connection: undefined,
  chatStation:undefined,

  /**
   * Initialize the converse with settings
   * make a session with the bosh session id
   */
  init: function(){

      var chatSetting = TO.ChatSettings.create({
        bosh_service_url:'http://localhost:7070/http-bind/'
      });

      this.connection = TO.Connection.create({
        settings: chatSetting
      });


      converse.initialize({
          bosh_service_url:'http://localhost:7070/http-bind/',//'http://openfire.mfsnet.io:7070/http-bind/ ',// Please use this connection manager only for testing purposes
          keepalive: true,
          message_carbons: true,
          play_sounds: true,
          roster_groups: true,
          show_controlbox_by_default: true,
          xhr_user_search: false,
          debug:true

      });
    var id = b64_sha1('converse.bosh-session');

    let session = this.store.createRecord('session', {
      sessid: id
    });
    session.save();
    let messages = this.store.createRecord('messages',{
      msgid :b64_sha1('converse.messages'+this.get('jid')+converse.bare_jid)
    });
    messages.save();
    console.log('connection JID'+ converse.connection.jid);
    let chatbox = this.store.createRecord('chat-box',{
      chat_state: undefined,
    });
    chatbox.save();
    initHandlers();
    console.log('Initialization completed');


    //let contacts = tawasul2.findRoster();


  },


  myfunc: function (){
    alert('my Func');
  },

  model()
  {
    return {
      data: this.store.findAll('message'),
      roster: this.store.findAll('roster-contact',{resource : tawasul2.converse.jid}),
      message: {}
    }
  },

  actions: {

    logIn(info){

      converse.connection.connect( info.jid, info.pw, converse.onConnectStatusChanged);
      let logUser = this.store.createRecord('log-user', {
        host:info.host,
        jid:info.jid
      });
      logUser.save();
      initHandlers();
    },


    initializeChat(config){
      console.log('Initialize converse...');
      tawasul2.converse.initialize(config);
      console.log('Initialized!!!')
    },

    createMessage(info){

      var bare_jid = this.get('jid');
      alert(bare_jid);
      var messageStanza = $msg({
        from: tawasul2.converse.connection.jid,
        to: bare_jid,
        type: 'chat',
        id: message.get('msgid')})
        .c('body').t(message.get('message')).up()
        .c(ACTIVE, {'xmlns': Strophe.NS.CHATSTATES}).up();

      if (this.model.get('otr_status') !== UNENCRYPTED) {
        // OTR messages aren't carbon copied
        messageStanza.c('private', {'xmlns': Strophe.NS.CARBONS});
      }
      tawasul2.converse.connection.send(messageStanza);
      if (tawasul2.converse.forward_messages) {
        // Forward the message, so that other connected resources are also aware of it.
        tawasul2.converse.connection.send(
          $msg({ to: converse.bare_jid, type: 'chat', id: message.get('msgid') })
            .c('forwarded', {xmlns:'urn:xmpp:forward:0'})
            .c('delay', {xmns:'urn:xmpp:delay',stamp:(new Date()).getTime()}).up()
            .cnode(messageStanza.tree())
        );
      }

      //alert('route');
      var timestamp = (new Date()).getTime();
      let message = this.store.createRecord('message', {
        mid: timestamp,
        body: info.body,
        host: 'jema@localhost'
      });
      message.save();

      //let newPost = this.store.createRecord('post', {
      //  title: info.title,
      //  text: info.text,
      //  author: info.author,
      //  createdDate: new Date()
      //});
      //
      //newPost.save();

    },

    createSession(info)
    {
      let newPost = this.store.createRecord('post', {
        title: info.title,
        text: info.text,
        author: info.author,
        createdDate: new Date()
      });

      newPost.save();
      alert(this.store + ' ' + newPost);
    }
  }


});
