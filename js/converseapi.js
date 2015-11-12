//coversejs

// Converse.js (A browser based XMPP chat client)
// http://conversejs.org
//`
// Copyright (c) 2012-2015, Jan-Carel Brand <jc@opkode.com>
// Licensed under the Mozilla Public License (MPLv2)

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD module loading
    // ------------------
    // When using require.js, two modules are loaded as dependencies.
    //
    // * **converse-dependencies**: A list of dependencies on which converse.js
    // depends. The path to this module is in main.js and the module itself can
    //
    // * **converse-templates**: The HTML templates used by converse.js.
    //
    // The dependencies are then split up and  passed into the factory function, which
    // contains and instantiates converse.js.
    define("converse",
        ["converse-dependencies", "converse-templates"],
        function (dependencies, templates) {
          return factory(
              templates,
              dependencies.jQuery,
              dependencies.$iq,
              dependencies.$msg,
              dependencies.$pres,
              dependencies.$build,
              dependencies.otr ? dependencies.otr.DSA : undefined,
              dependencies.otr ? dependencies.otr.OTR : undefined,
              dependencies.Strophe,
              dependencies.underscore,
              dependencies.moment,
              dependencies.utils,
              dependencies.SHA1.b64_sha1
          );
        }
    );
  } else {
    // When not using a module loader
    // -------------------------------
    // In this case, the dependencies need to be available already as
    // global variables, and should be loaded separately via *script* tags.
    // See the file **non_amd.html** for an example of this usecase.
    root.converse = factory(templates, jQuery, $iq, $msg, $pres, $build, DSA, OTR, Strophe, _, moment, utils, b64_sha1);
  }
}(this, function (templates, $, $iq, $msg, $pres, $build, DSA, OTR, Strophe, _, moment, utils, b64_sha1) {
  /* "use strict";
   * Cannot use this due to Safari bug.
   * See https://github.com/jcbrand/converse.js/issues/196
   */
  if (typeof console === "undefined" || typeof console.log === "undefined") {
    console = { log: function () {}, error: function () {} };
  }

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

  // XXX: these can perhaps be moved to src/polyfills.js
  String.prototype.splitOnce = function (delimiter) {
    var components = this.split(delimiter);
    return [components.shift(), components.join(delimiter)];
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
    Strophe.log = function (level, msg) { converse.log(level+' '+msg, level); };
    Strophe.error = function (msg) { converse.log(msg, 'error'); };

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
    Strophe.addNamespace('RECEIPTS', 'urn:xmpp:receipts');
    Strophe.addNamespace('CHATMARKER', 'urn:xmpp:chat-markers:0');

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
////////////////////////////////////////////////////////////////////////////////////////////////

    // XEP-0333
    var RECIEVD = 'recieved';
    var DISPLAYED = 'displayed';
    var ACKNOWLEDGED = 'acknowledged';

    // XEP-0184
    var DELIVERED = 'delivered';
    var SENT = 'sent';


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
    this.isMomentLocale = function (locale) { return moment.locale() != moment.locale(locale); };

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
        if (sublocale != locale && available(sublocale)) {
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
      message_archiving: 'always', // Supported values are 'always', 'never', 'roster' (See https://xmpp.org/extensions/xep-0313.html#prefs )
      message_carbons: false, // Support for XEP-280
      muc_history_max_stanzas: undefined, // Takes an integer, limits the amount of messages to fetch from chat room's history
      no_trimming: false, // Set to true for phantomjs tests (where browser apparently has no width)
      ping_interval: 180, //in seconds
      play_sounds: false,
      sounds_path: '/converse-demo/sounds/',
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
        'toggle_participants': true
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
                'emoticons', 'call', 'clear', 'toggle_participants'
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
      if (this.debug) {
        if (level == 'error') {
          console.log('ERROR: '+txt);
        } else {
          console.log(txt);
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
      converse.log('Attempting to reconnect in 5 seconds');
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
      converse.log("Status changed to: "+PRETTY_CONNECTION_STATUS[status]);
      if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
        delete converse.disconnection_cause;
        if ((typeof reconnect !== 'undefined') && (reconnect)) {
          converse.log(status === Strophe.Status.CONNECTED ? 'Reconnected' : 'Reattached');
          converse.onReconnected();
        } else {
          converse.log(status === Strophe.Status.CONNECTED ? 'Connected' : 'Attached');
          converse.onConnected();
        }
      } else if (status === Strophe.Status.DISCONNECTED) {
        if (converse.disconnection_cause == Strophe.Status.CONNFAIL && converse.auto_reconnect) {
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

    this.applyHeightResistance = function (height) {
      /* This method applies some resistance/gravity around the
       * "default_box_height". If "height" is close enough to
       * default_box_height, then that is returned instead.
       */
      if (typeof height === 'undefined') {
        return converse.default_box_height;
      }
      var resistance = 10;
      if ((height !== converse.default_box_height) &&
          (Math.abs(height - converse.default_box_height) < resistance)) {
        return converse.default_box_height;
      }
      return height;
    };

    this.updateMsgCounter = function () {
      if (this.msg_counter > 0) {
        if (document.title.search(/^Messages \(\d+\) /) == -1) {
          document.title = "Messages (" + this.msg_counter + ") " + document.title;
        } else {
          document.title = document.title.replace(/^Messages \(\d+\) /, "Messages (" + this.msg_counter + ") ");
        }
        window.blur();
        window.focus();
      } else if (document.title.search(/^Messages \(\d+\) /) != -1) {
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
      this.xmppstatus = new this.XMPPStatus();
      var id = b64_sha1('converse.xmppstatus-'+converse.bare_jid);
      this.xmppstatus.id = id; // Appears to be necessary for backbone.browserStorage
      this.xmppstatus.browserStorage = new Backbone.BrowserStorage[converse.storage](id);
      this.xmppstatus.fetch({success: callback, error: callback});
    };

    this.initSession = function () {
      this.session = new this.Session();
      var id = b64_sha1('converse.bosh-session');
      //Ember.set(this.session,'id', id); // Appears to be necessary for backbone.browserStorage
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
      converse.chatboxviews.closeAllChatBoxes(false);
      converse.clearSession();
      converse.connection.disconnect();
    };

    this.registerGlobalEventHandlers = function () {
      $(document).click(function () {
        // if(msgTransferStat == true){
        //   // this.trigger('sendMessage', '/read');
        //   // this.model.chatboxview.sendMessage('/read');
        //   msgTransferStat = false;
        // }

        if ($('.toggle-otr ul').is(':visible')) {
          $('.toggle-otr ul', this).slideUp();
        }
        if ($('.toggle-smiley ul').is(':visible')) {
          $('.toggle-smiley ul', this).slideUp();
        }
      });

      $(document).on('mousemove', function (ev) {

        if (!this.resized_chatbox || !this.allow_dragresize) { return true; }
        ev.preventDefault();
        this.resized_chatbox.resizeChatBox(ev);
      }.bind(this));

      $(document).on('mouseup', function (ev) {
        if (!this.resized_chatbox || !this.allow_dragresize) { return true; }
        ev.preventDefault();
        var height = this.applyHeightResistance(this.resized_chatbox.height);
        if (this.connection.connected) {
          this.resized_chatbox.model.save({'height': height});
        } else {
          this.resized_chatbox.model.set({'height': height});
        }
        this.resized_chatbox = null;
      }.bind(this));

      $(window).on("blur focus", function (ev) {

        converse.connection.receipts.sendSeen();
        if ((this.windowState != ev.type) && (ev.type == 'focus')) {
          converse.clearMsgCounter();
        }
        this.windowState = ev.type;
      }.bind(this));

      $(window).on("resize", _.debounce(function (ev) {
        this.chatboxviews.trimChats();
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

    this.receipt = function(msg){
      //    alert(msg);
      //should resend the letter for confirmation
      return true;
    };

    this.registerReceiptHandler = function(){
      //  alert('the register');
      // converse.connection.receipts.addReceiptHandler(this.receipt, "get"c, this.connection.jid, true);

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
        this.registerReceiptHandler();
        this.registerPingHandler();
        this.rosterview.registerRosterXHandler();
        this.rosterview.registerPresenceHandler();
        this.chatboxes.registerMessageHandler();
        this.xmppstatus.sendPresence();
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
          converse.log('ERROR: An error occured while trying to enable message carbons.');
        } else {
          this.session.save({carbons_enabled: true});
          converse.log('Message carbons have been enabled.');
        }
      }.bind(this), null, "iq", null, "enablecarbons");
      this.connection.send(carbons_iq);
    };

    this.onConnected = function () {
      // When reconnecting, there might be some open chat boxes. We don't
      // know whether these boxes are of the same account or not, so we
      // close them now.
      this.chatboxviews.closeAllChatBoxes();
      this.jid = this.connection.jid;
      this.bare_jid = Strophe.getBareJidFromJid(this.connection.jid);
      this.resource = Strophe.getResourceFromJid(this.connection.jid);
      this.domain = Strophe.getDomainFromJid(this.connection.jid);
      this.minimized_chats = new converse.MinimizedChats({model: this.chatboxes});
      this.features = new this.Features();
      this.enableCarbons();
      this.initStatus(function () {
        this.registerReceiptHandler();
        this.registerPingHandler();
        this.registerIntervalHandler();
        this.chatboxes.onConnected();
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

    // Backbone Models and Views
    // -------------------------
    this.OTR = DS.Model.extend({
      // A model for managing OTR settings.
      getSessionPassphrase: function () {
        if (converse.authentication === 'prebind') {
          var key = b64_sha1(converse.connection.jid),
              pass = window.sessionStorage[key];
          if (typeof pass === 'undefined') {
            pass = Math.floor(Math.random()*4294967295).toString();
            window.sessionStorage[key] = pass;
          }
          return pass;
        } else {
          return converse.connection.pass;
        }
      },

      generatePrivateKey: function () {
        var key = new DSA();
        var jid = converse.connection.jid;
        if (converse.cache_otr_key) {
          var cipher = CryptoJS.lib.PasswordBasedCipher;
          var pass = this.getSessionPassphrase();
          if (typeof pass !== "undefined") {
            // Encrypt the key and set in sessionStorage. Also store instance tag.
            window.sessionStorage[b64_sha1(jid+'priv_key')] =
                cipher.encrypt(CryptoJS.algo.AES, key.packPrivate(), pass).toString();
            window.sessionStorage[b64_sha1(jid+'instance_tag')] = instance_tag;
            window.sessionStorage[b64_sha1(jid+'pass_check')] =
                cipher.encrypt(CryptoJS.algo.AES, 'match', pass).toString();
          }
        }
        return key;
      }
    });

    this.Message = DS.Model;
    this.Messages = DS.Model.extend({
      content: converse.Message,
      comparator: 'time'
    });

    this.ChatBox = DS.Model.extend({

      initialize: function () {
        var height = this.get('height');

        // $(document).click(function () {
        //   if(msgTransferStat == true){
        //     alert('clicked')
        //     this.sendMessage('/read');
        //     // this.model.chatboxview.sendMessage('/read');
        //     msgTransferStat = false;
        //   }
        // });

        if (this.get('box_id') !== 'controlbox') {
          this.messages = new converse.Messages();
          this.messages.browserStorage = new Backbone.BrowserStorage[converse.storage](
              b64_sha1('converse.messages'+this.get('jid')+converse.bare_jid));
          this.save({
            // The chat_state will be set to ACTIVE once the chat box is opened
            // and we listen for change:chat_state, so shouldn't set it to ACTIVE here.
            'chat_state': undefined,
            'box_id' : b64_sha1(this.get('jid')),
            'height': height ? converse.applyHeightResistance(height) : undefined,
            'minimized': this.get('minimized') || false,
            'num_unread': this.get('num_unread') || 0,
            'otr_status': this.get('otr_status') || UNENCRYPTED,
            'time_minimized': this.get('time_minimized') || moment(),
            'time_opened': this.get('time_opened') || moment().valueOf(),
            'url': '',
            'user_id' : Strophe.getNodeFromJid(this.get('jid'))
          });
        } else {
          this.set({
            'height': height ? converse.applyHeightResistance(height) : undefined,
            'time_opened': moment(0).valueOf(),
            'num_unread': this.get('num_unread') || 0
          });
        }

      },

      maximize: function () {
        this.save({
          'minimized': false,
          'time_opened': moment().valueOf()
        });
      },

      minimize: function () {
        this.save({
          'minimized': true,
          'time_minimized': moment().format()
        });
      },

      getSession: function (callback) {
        var cipher = CryptoJS.lib.PasswordBasedCipher;
        var result, pass, instance_tag, saved_key, pass_check;
        if (converse.cache_otr_key) {
          pass = converse.otr.getSessionPassphrase();
          if (typeof pass !== "undefined") {
            instance_tag = window.sessionStorage[b64_sha1(this.id+'instance_tag')];
            saved_key = window.sessionStorage[b64_sha1(this.id+'priv_key')];
            pass_check = window.sessionStorage[b64_sha1(this.connection.jid+'pass_check')];
            if (saved_key && instance_tag && typeof pass_check !== 'undefined') {
              var decrypted = cipher.decrypt(CryptoJS.algo.AES, saved_key, pass);
              var key = DSA.parsePrivate(decrypted.toString(CryptoJS.enc.Latin1));
              if (cipher.decrypt(CryptoJS.algo.AES, pass_check, pass).toString(CryptoJS.enc.Latin1) === 'match') {
                // Verified that the passphrase is still the same
                this.trigger('showHelpMessages', [__('Re-establishing encrypted session')]);
                callback({
                  'key': key,
                  'instance_tag': instance_tag
                });
                return; // Our work is done here
              }
            }
          }
        }
        // We need to generate a new key and instance tag
        this.trigger('showHelpMessages', [
              __('Generating private key.'),
              __('Your browser might become unresponsive.')],
            null,
            true // show spinner
        );
        setTimeout(function () {
          callback({
            'key': converse.otr.generatePrivateKey.apply(this),
            'instance_tag': OTR.makeInstanceTag()
          });
        }, 500);
      },

      updateOTRStatus: function (state) {
        switch (state) {
          case OTR.CONST.STATUS_AKE_SUCCESS:
            if (this.otr.msgstate === OTR.CONST.MSGSTATE_ENCRYPTED) {
              this.save({'otr_status': UNVERIFIED});
            }
            break;
          case OTR.CONST.STATUS_END_OTR:
            if (this.otr.msgstate === OTR.CONST.MSGSTATE_FINISHED) {
              this.save({'otr_status': FINISHED});
            } else if (this.otr.msgstate === OTR.CONST.MSGSTATE_PLAINTEXT) {
              this.save({'otr_status': UNENCRYPTED});
            }
            break;
        }
      },

      onSMP: function (type, data) {
        // Event handler for SMP (Socialist's Millionaire Protocol)
        // used by OTR (off-the-record).
        switch (type) {
          case 'question':
            this.otr.smpSecret(prompt(__(
                'Authentication request from %1$s\n\nYour chat contact is attempting to verify your identity, by asking you the question below.\n\n%2$s',
                [this.get('fullname'), data])));
            break;
          case 'trust':
            if (data === true) {
              this.save({'otr_status': VERIFIED});
            } else {
              this.trigger(
                  'showHelpMessages',
                  [__("Could not verify this user's identify.")],
                  'error');
              this.save({'otr_status': UNVERIFIED});
            }
            break;
          default:
            throw new TypeError('ChatBox.onSMP: Unknown type for SMP');
        }
      },

      initiateOTR: function (query_msg) {
        // Sets up an OTR object through which we can send and receive
        // encrypted messages.
        //
        // If 'query_msg' is passed in, it means there is an alread incoming
        // query message from our contact. Otherwise, it is us who will
        // send the query message to them.
        this.save({'otr_status': UNENCRYPTED});
        var session = this.getSession(function (session) {
          this.otr = new OTR({
            fragment_size: 140,
            send_interval: 200,
            priv: session.key,
            instance_tag: session.instance_tag,
            debug: this.debug
          });
          this.otr.on('status', this.updateOTRStatus.bind(this));
          this.otr.on('smp', this.onSMP.bind(this));

          this.otr.on('ui', function (msg) {
            this.trigger('showReceivedOTRMessage', msg);
          }.bind(this));
          this.otr.on('io', function (msg) {
            this.trigger('sendMessage', msg);
          }.bind(this));
          this.otr.on('error', function (msg) {
            this.trigger('showOTRError', msg);
          }.bind(this));

          this.trigger('showHelpMessages', [__('Exchanging private key with contact.')]);
          if (query_msg) {
            this.otr.receiveMsg(query_msg);
          } else {
            this.otr.sendQueryMsg();
          }
        }.bind(this));
      },

      endOTR: function () {
        if (this.otr) {
          this.otr.endOtr();
        }
        this.save({'otr_status': UNENCRYPTED});
      },

      createMessage: function ($message, $delay, archive_id) {
        //   alert();
        $delay = $delay || $message.find('delay');
        var body = $message.children('body').text(),
            delayed = $delay.length > 0,
            fullname = this.get('fullname'),
            is_groupchat = $message.attr('type') === 'groupchat',
            msgid = $message.attr('id'),
            chat_state = $message.find(COMPOSING).length && COMPOSING ||
                $message.find(PAUSED).length && PAUSED ||
                $message.find(INACTIVE).length && INACTIVE ||
                $message.find(ACTIVE).length && ACTIVE ||
                $message.find(GONE).length && GONE,
            stamp, time, sender, from;

        if (is_groupchat) {
          from = Strophe.unescapeNode(Strophe.getResourceFromJid($message.attr('from')));
        } else {
          from = Strophe.getBareJidFromJid($message.attr('from'));
        }
        fullname = (_.isEmpty(fullname) ? from: fullname).split(' ')[0];
        if (delayed) {
          stamp = $delay.attr('stamp');
          time = stamp;
        } else {
          time = moment().format();
        }
        if ((is_groupchat && from === this.get('nick')) || (!is_groupchat && from == converse.bare_jid)) {
          sender = 'me';
        } else {
          sender = 'them';
        }
        this.messages.create({
          chat_state: chat_state,
          delayed: delayed,
          fullname: fullname,
          message: body || undefined,
          msgid: msgid,
          sender: sender,
          time: time,
          archive_id: archive_id
        });
      },

      receiveMessage: function ($message, $delay, archive_id) {
        // alert('reciev');
        var $body = $message.children('body');
        var text = ($body.length > 0 ? $body.text() : undefined);
        if ((!text) || (!converse.allow_otr)) {
          return this.createMessage($message, $delay, archive_id);
        }
        if (text.match(/^\?OTRv23?/)) {
          this.initiateOTR(text);
        } else {
          if (_.contains([UNVERIFIED, VERIFIED], this.get('otr_status'))) {
            this.otr.receiveMsg(text);
          } else {
            if (text.match(/^\?OTR/)) {
              if (!this.otr) {
                this.initiateOTR(text);
              } else {
                this.otr.receiveMsg(text);
              }
            } else {


              var mark = $message.find('markable');
              var recv = $message.find('received');
              var disp = $message.find('displayed');
              // alert(disp.length);
              converse.connection.receipts._processReceipt($message);

              // alert(recv.length);
              //  alert(mark.length);

              //     if(mark.length > 0){
              //       alert('deleverd');
              // //      this.createMessage($message, $delay, archive_id);

              //     }else
              if(recv.length > 0){
                alert('DELIVERED');
              }else if(disp.length > 0){
                //read implementation
                alert('DISPLAYED');
                // this.createMessage($message, $delay, archive_id);
              }else if(mark.length > 0){
                this.createMessage($message, $delay, archive_id);

                //   alert('got a markable new message, sending delevery');
                //   // Normal unencrypted message.
                //
                // //  sendMessage('sss');
                // //  $message.children('body').text('sss') //= 'Recieved By';
                //   text = '/delivered';
                //   this.createMessage($message, $delay, archive_id);
                // //  this.converse.receipts._processReceipt($message);
                //   var timestamp = (new Date()).getTime();
                //   // //  alert(0);
                //   var bare_jid =  Strophe.getBareJidFromJid($message.attr('from'));//this.model.get('jid');
                //    //var id = $message.attr('id');////////////
                // //   alert(bare_jid);
                //   var recid = $message.attr('id');
                //
                //   alert(recid+' he');
                //    var message = $msg({
                //      from: converse.connection.jid,
                //      to: bare_jid,
                //      type: 'chat'
                //    })
                //
                //     .c('body').t(text).up()
                //     .c(ACTIVE, {'xmlns': Strophe.NS.CHATSTATES}).up()
                //     .c('received', {'xmlns': Strophe.NS.CHATMARKER, 'id':recid }).up();
                //       alert(message);
                //       converse.connection.send(message);
                //       alert('sent delevery receipt');
                msgTransferStat = true;
              }
              // if (converse.forward_messages) {
              //     // Forward the message, so that other connected resources are also aware of it.
              //     var forwarded = $msg({to:converse.bare_jid, type:'chat', id:timestamp})
              //                     .c('forwarded', {xmlns:'urn:xmpp:forward:0'})
              //                     .c('delay', {xmns:'urn:xmpp:delay',stamp:timestamp}).up()
              //                     .cnode(message.tree());
              //     converse.connection.send(forwarded);
              // }
              //

            }
          }
        }
      }
    });

    var msgTransferStat = false;

    this.ChatRoomOccupant = DS.Model;

    this.ChatRoomOccupants = DS.Model.extend({
      content: converse.ChatRoomOccupant
    });

    this.ChatBoxes = DS.Model.extend({
      content: converse.ChatBox,
      comparator: 'time_opened',

      registerMessageHandler: function () {
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

      onConnected: function () {
        this.browserStorage = new Backbone.BrowserStorage[converse.storage](
            b64_sha1('converse.chatboxes-'+converse.bare_jid));
        this.registerMessageHandler();
        this.fetch({
          add: true,
          success: function (collection, resp) {
            collection.each(function (chatbox) {
              if (chatbox.get('id') !== 'controlbox' && !chatbox.get('minimized')) {
                chatbox.trigger('show');
              }
            });
            if (!_.include(_.pluck(resp, 'id'), 'controlbox')) {
              this.add({
                id: 'controlbox',
                box_id: 'controlbox'
              });
            }
            this.get('controlbox').save({connected:true});
          }.bind(this)
        });
      },

      isOnlyChatStateNotification: function ($msg) {
        // See XEP-0085 Chat State Notification
        return (
            $msg.find('body').length === 0 && (
                $msg.find(ACTIVE).length !== 0 ||
                $msg.find(COMPOSING).length !== 0 ||
                $msg.find(INACTIVE).length !== 0 ||
                $msg.find(PAUSED).length !== 0 ||
                $msg.find(GONE).length !== 0
            )
        );
      },

      onInvite: function (message) {
        var $message = $(message),
            $x = $message.children('x[xmlns="jabber:x:conference"]'),
            from = Strophe.getBareJidFromJid($message.attr('from')),
            room_jid = $x.attr('jid'),
            reason = $x.attr('reason'),
            contact = converse.roster.get(from),
            result;

        if (!reason) {
          result = confirm(
              __(___("%1$s has invited you to join a chat room: %2$s"), contact.get('fullname'), room_jid)
          );
        } else {
          result = confirm(
              __(___('%1$s has invited you to join a chat room: %2$s, and left the following reason: "%3$s"'),
                  contact.get('fullname'), room_jid, reason)
          );
        }
        if (result === true) {
          var chatroom = converse.chatboxviews.showChat({
            'id': room_jid,
            'jid': room_jid,
            'name': Strophe.unescapeNode(Strophe.getNodeFromJid(room_jid)),
            'nick': Strophe.unescapeNode(Strophe.getNodeFromJid(converse.connection.jid)),
            'chatroom': true,
            'box_id' : b64_sha1(room_jid),
            'password': $x.attr('password')
          });
          if (!_.contains(
                  [Strophe.Status.CONNECTING, Strophe.Status.CONNECTED],
                  chatroom.get('connection_status'))
          ) {
            converse.chatboxviews.get(room_jid).join(null);
          }
        }
      },

      onMessage: function (message) {
        /* Handler method for all incoming single-user chat "message" stanzas.
         */
        var $message = $(message),
            contact_jid, $forwarded, $delay, from_bare_jid, from_resource, is_me, msgid,
            chatbox, resource, roster_item,
            from_jid = $message.attr('from'),
            to_jid = $message.attr('to'),
            to_resource = Strophe.getResourceFromJid(to_jid),
            archive_id = $message.find('result[xmlns="'+Strophe.NS.MAM+'"]').attr('id');

        if (to_resource && to_resource !== converse.resource) {
          converse.log('Ignore incoming message intended for a different resource: '+to_jid, 'info');
          return true;
        }
        if (from_jid === converse.connection.jid) {
          // FIXME: Forwarded messages should be sent to specific resources, not broadcasted
          converse.log("Ignore incoming message sent from this client's JID: "+from_jid, 'info');
          return true;
        }
        $forwarded = $message.find('forwarded');
        if ($forwarded.length) {
          $message = $forwarded.children('message');
          $delay = $forwarded.children('delay');
          from_jid = $message.attr('from');
          to_jid = $message.attr('to');
        }
        from_bare_jid = Strophe.getBareJidFromJid(from_jid);
        from_resource = Strophe.getResourceFromJid(from_jid);
        is_me = from_bare_jid == converse.bare_jid;
        msgid = $message.attr('id');

        if (is_me) {
          // I am the sender, so this must be a forwarded message...
          contact_jid = Strophe.getBareJidFromJid(to_jid);
          resource = Strophe.getResourceFromJid(to_jid);
        } else {
          contact_jid = from_bare_jid;
          resource = from_resource;
        }
        // Get chat box, but only create a new one when the message has a body.
        chatbox = this.getChatBox(contact_jid, $message.find('body').length > 0);
        if (!chatbox) {
          return true;
        }
        if (msgid && chatbox.messages.findWhere({msgid: msgid})) {
          return true; // We already have this message stored.
        }
        if (!this.isOnlyChatStateNotification($message) && !is_me && !$forwarded.length) {
          converse.playNotification();
        }
        chatbox.receiveMessage($message, $delay, archive_id);
        converse.roster.addResource(contact_jid, resource);
        converse.emit('message', message);
        //this.setChatState(COMPOSING, false);
        return true;
      },

      getChatBox: function (jid, create) {
        /* Returns a chat box or optionally return a newly
         * created one if one doesn't exist.
         *
         * Parameters:
         *    (String) jid - The JID of the user whose chat box we want
         *    (Boolean) create - Should a new chat box be created if none exists?
         */
        var bare_jid = Strophe.getBareJidFromJid(jid);
        var chatbox = this.get(bare_jid);
        if (!chatbox && create) {
          var roster_item = converse.roster.get(bare_jid);
          if (roster_item === undefined) {
            converse.log('Could not get roster item for JID '+bare_jid, 'error');
            return;
          }
          chatbox = this.create({
            'id': bare_jid,
            'jid': bare_jid,
            'fullname': _.isEmpty(roster_item.get('fullname'))? jid: roster_item.get('fullname'),
            'image_type': roster_item.get('image_type'),
            'image': roster_item.get('image'),
            'url': roster_item.get('url')
          });
        }
        return chatbox;
      }
    });

    this.MinimizedChatsToggle = DS.Model.extend({
      initialize: function () {
        this.set({
          'collapsed': this.get('collapsed') || false,
          'num_minimized': this.get('num_minimized') || 0,
          'num_unread':  this.get('num_unread') || 0
        });
      }
    });

    this.RosterContact = DS.Model.extend({
      initialize: function (attributes, options) {
        var jid = attributes.jid;
        var bare_jid = Strophe.getBareJidFromJid(jid);
        var resource = Strophe.getResourceFromJid(jid);
        attributes.jid = bare_jid;
        this.set(_.extend({
          'id': bare_jid,
          'jid': bare_jid,
          'fullname': bare_jid,
          'chat_status': 'offline',
          'user_id': Strophe.getNodeFromJid(jid),
          'resources': resource ? [resource] : [],
          'groups': [],
          'image_type': 'image/png',
          'image': "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH3gwHCy455JBsggAABkJJREFUeNrtnM1PE1sUwHvvTD8otWLHST/Gimi1CEgr6M6FEWuIBo2pujDVsNDEP8GN/4MbN7oxrlipG2OCgZgYlxAbkRYw1KqkIDRCSkM7nXvvW8x7vjyNeQ9m7p1p3z1LQk/v/Dhz7vkEXL161cHl9wI5Ag6IA+KAOCAOiAPigDggLhwQB2S+iNZ+PcYY/SWEEP2HAAAIoSAIoihCCP+ngDDGtVotGAz29/cfOXJEUZSOjg6n06lp2sbGRqlUWlhYyGazS0tLbrdbEASrzgksyeYJId3d3el0uqenRxRFAAAA4KdfIIRgjD9+/Pj8+fOpqSndslofEIQwHA6Pjo4mEon//qmFhYXHjx8vLi4ihBgDEnp7e9l8E0Jo165dQ0NDd+/eDYVC2/qsJElDQ0OEkKWlpa2tLZamxAhQo9EIBoOjo6MXL17csZLe3l5FUT59+lQul5l5JRaAVFWNRqN37tw5ceKEQVWRSOTw4cOFQuHbt2+iKLYCIISQLMu3b99OJpOmKAwEAgcPHszn8+vr6wzsiG6UQQhxuVyXLl0aGBgwUW0sFstkMl6v90fo1KyAMMYDAwPnzp0zXfPg4GAqlWo0Gk0MiBAiy/L58+edTqf5Aa4onj59OhaLYYybFRCEMBaL0fNxBw4cSCQStN0QRUBut3t4eJjq6U+dOiVJElVPRBFQIBDo6+ujCqirqyscDlONGykC2lYyYSR6pBoQQapHZwAoHo/TuARYAOrs7GQASFEUqn6aIiBJkhgA6ujooFpUo6iaTa7koFwnaoWadLNe81tbWwzoaJrWrICWl5cZAFpbW6OabVAEtLi4yABQsVjUNK0pAWWzWQaAcrlcswKanZ1VVZUqHYRQEwOq1Wpv3ryhCmh6erpcLjdrNl+v1ycnJ+l5UELI27dvv3//3qxxEADgy5cvExMT9Mznw4cPtFtAdAPFarU6Pj5eKpVM17yxsfHy5cvV1VXazXu62gVBKBQKT58+rdVqJqrFGL948eLdu3dU8/g/H4FBUaJYLAqC0NPTY9brMD4+PjY25mDSracOCABACJmZmXE6nUePHjWu8NWrV48ePSKEsGlAs7Agfd5nenq6Wq0mk0kjDzY2NvbkyRMIIbP2PLvhBUEQ8vl8NpuNx+M+n29bzhVjvLKycv/+/YmJCcazQuwA6YzW1tYmJyf1SY+2trZ/rRk1Go1SqfT69esHDx4UCgVmNaa/zZ/9ABUhRFXVYDB48uTJeDweiUQkSfL7/T9MA2NcqVTK5fLy8vL8/PzU1FSxWHS5XJaM4wGr9sUwxqqqer3eUCgkSZJuUBBCfTRvc3OzXC6vrKxUKhWn02nhCJ5lM4oQQo/HgxD6+vXr58+fHf8sDOp+HQDg8XgclorFU676dKLlo6yWRdItIBwQB8QBcUCtfosRQjRNQwhhjPUC4w46WXryBSHU1zgEQWBz99EFhDGu1+t+v//48ePxeFxRlD179ng8nh0Efgiher2+vr6ur3HMzMysrq7uTJVdACGEurq6Ll++nEgkPB7Pj9jPoDHqOxyqqubz+WfPnuVyuV9XPeyeagAAAoHArVu3BgcHab8CuVzu4cOHpVKJUnfA5GweY+xyuc6cOXPv3r1IJMLAR8iyPDw8XK/Xi8Wiqqqmm5KZgBBC7e3tN27cuHbtGuPVpf7+/lAoNDs7W61WzfVKpgHSSzw3b95MpVKW3MfRaDQSiczNzVUqFRMZmQOIEOL1eq9fv3727FlL1t50URRFluX5+flqtWpWEGAOIFEUU6nUlStXLKSjy759+xwOx9zcnKZpphzGHMzhcDiTydgk9r1w4YIp7RPTAAmCkMlk2FeLf/tIEKbTab/fbwtAhJBoNGrutpNx6e7uPnTokC1eMU3T0um0DZPMkZER6wERQnw+n/FFSxpy7Nix3bt3WwwIIcRgIWnHkkwmjecfRgGx7DtuV/r6+iwGhDHev3+/bQF1dnYaH6E2CkiWZdsC2rt3r8WAHA5HW1ubbQGZcjajgOwTH/4qNko1Wlg4IA6IA+KAOKBWBUQIsfNojyliKIoRRfH9+/dut9umf3wzpoUNNQ4BAJubmwz+ic+OxefzWWlBhJD29nbug7iT5sIBcUAcEAfEAXFAHBAHxOVn+QMrmWpuPZx12gAAAABJRU5ErkJggg==",
          'status': ''
        }, attributes));

        this.on('destroy', function () { this.removeFromRoster(); }.bind(this));
      },

      subscribe: function (message) {
        /* Send a presence subscription request to this roster contact
         *
         * Parameters:
         *    (String) message - An optional message to explain the
         *      reason for the subscription request.
         */
        this.save('ask', "subscribe"); // ask === 'subscribe' Means we have ask to subscribe to them.
        var pres = $pres({to: this.get('jid'), type: "subscribe"});
        if (message && message !== "") {
          pres.c("status").t(message).up();
        }
        var nick = converse.xmppstatus.get('fullname');
        if (nick && nick !== "") {
          pres.c('nick', {'xmlns': Strophe.NS.NICK}).t(nick).up();
        }
        converse.connection.send(pres);
        return this;
      },

      ackSubscribe: function () {
        /* Upon receiving the presence stanza of type "subscribed",
         * the user SHOULD acknowledge receipt of that subscription
         * state notification by sending a presence stanza of type
         * "subscribe" to the contact
         */
        converse.connection.send($pres({
          'type': 'subscribe',
          'to': this.get('jid')
        }));
      },

      ackUnsubscribe: function (jid) {
        /* Upon receiving the presence stanza of type "unsubscribed",
         * the user SHOULD acknowledge receipt of that subscription state
         * notification by sending a presence stanza of type "unsubscribe"
         * this step lets the user's server know that it MUST no longer
         * send notification of the subscription state change to the user.
         *  Parameters:
         *    (String) jid - The Jabber ID of the user who is unsubscribing
         */
        converse.connection.send($pres({'type': 'unsubscribe', 'to': this.get('jid')}));
        this.destroy(); // Will cause removeFromRoster to be called.
      },

      unauthorize: function (message) {
        /* Unauthorize this contact's presence subscription
         * Parameters:
         *   (String) message - Optional message to send to the person being unauthorized
         */
        converse.rejectPresenceSubscription(this.get('jid'), message);
        return this;
      },

      authorize: function (message) {
        /* Authorize presence subscription
         * Parameters:
         *   (String) message - Optional message to send to the person being authorized
         */
        var pres = $pres({to: this.get('jid'), type: "subscribed"});
        if (message && message !== "") {
          pres.c("status").t(message);
        }
        converse.connection.send(pres);
        return this;
      },

      removeResource: function (resource) {
        var resources = this.get('resources'), idx;
        if (resource) {
          idx = _.indexOf(resources, resource);
          if (idx !== -1) {
            resources.splice(idx, 1);
            this.save({'resources': resources});
          }
        }
        return resources.length;
      },

      removeFromRoster: function (callback) {
        /* Instruct the XMPP server to remove this contact from our roster
         * Parameters:
         *   (Function) callback
         */
        var iq = $iq({type: 'set'})
            .c('query', {xmlns: Strophe.NS.ROSTER})
            .c('item', {jid: this.get('jid'), subscription: "remove"});
        converse.connection.sendIQ(iq, callback, callback);
        return this;
      },

      showInRoster: function () {
        var chatStatus = this.get('chat_status');
        if ((converse.show_only_online_users && chatStatus !== 'online') || (converse.hide_offline_users && chatStatus === 'offline')) {
          // If pending or requesting, show
          if ((this.get('ask') === 'subscribe') ||
              (this.get('subscription') === 'from') ||
              (this.get('requesting') === true)) {
            return true;
          }
          return false;
        }
        return true;
      }
    });

    this.RosterContacts = DS.Model.extend({
      content: converse.RosterContact,
      comparator: function (contact1, contact2) {
        var name1, name2;
        var status1 = contact1.get('chat_status') || 'offline';
        var status2 = contact2.get('chat_status') || 'offline';
        if (STATUS_WEIGHTS[status1] === STATUS_WEIGHTS[status2]) {
          name1 = contact1.get('fullname').toLowerCase();
          name2 = contact2.get('fullname').toLowerCase();
          return name1 < name2 ? -1 : (name1 > name2? 1 : 0);
        } else  {
          return STATUS_WEIGHTS[status1] < STATUS_WEIGHTS[status2] ? -1 : 1;
        }
      },

      subscribeToSuggestedItems: function (msg) {
        $(msg).find('item').each(function (i, items) {
          var $this = $(this);
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
              converse.log(err);
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
            if (_.indexOf(resources, resource) == -1) {
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

      onRosterPush: function (iq) {
        /* Handle roster updates from the XMPP server.
         * See: https://xmpp.org/rfcs/rfc6121.html#roster-syntax-actions-push
         *
         * Parameters:
         *    (XMLElement) IQ - The IQ stanza received from the XMPP server.
         */
        var id = iq.getAttribute('id');
        var from = iq.getAttribute('from');
        if (from && from !== "" && Strophe.getNodeFromJid(from) != converse.bare_jid) {
          // Receiving client MUST ignore stanza unless it has no from or from = user's bare JID.
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
        return true;
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
          if ((!contact) || (contact.get('subscription') != 'to')) {
            this.subscribeBack(bare_jid);
          } else {
            contact.authorize();
          }
        } else {
          if (contact) {
            if (contact.get('subscription') != 'none')  {
              contact.authorize();
            } else if (contact.get('ask') == "subscribe") {
              contact.authorize();
            }
          } else if (!contact) {
            converse.getVCard(
                bare_jid, this.createContactFromVCard.bind(this),
                function (iq, jid) {
                  converse.log("Error while retrieving vcard for "+jid);
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
        if (contact && (status_message.text() != contact.get('status'))) {
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

    this.RosterGroups = DS.Model.extend({
      content: converse.RosterGroup,
      comparator: function (a, b) {
        /* Groups are sorted alphabetically, ignoring case.
         * However, Ungrouped, Requesting Contacts and Pending Contacts
         * appear last and in that order. */
        a = a.get('name');
        b = b.get('name');
        var special_groups = _.keys(HEADER_WEIGHTS);
        var a_is_special = _.contains(special_groups, a);
        var b_is_special = _.contains(special_groups, b);
        if (!a_is_special && !b_is_special ) {
          return a.toLowerCase() < b.toLowerCase() ? -1 : (a.toLowerCase() > b.toLowerCase() ? 1 : 0);
        } else if (a_is_special && b_is_special) {
          return HEADER_WEIGHTS[a] < HEADER_WEIGHTS[b] ? -1 : (HEADER_WEIGHTS[a] > HEADER_WEIGHTS[b] ? 1 : 0);
        } else if (!a_is_special && b_is_special) {
          return (b === HEADER_CURRENT_CONTACTS) ? 1 : -1;
        } else if (a_is_special && !b_is_special) {
          return (a === HEADER_CURRENT_CONTACTS) ? -1 : 1;
        }
      }
    });

    this.XMPPStatus = DS.Model.extend({
      initialize: function () {
        this.set({
          'status' : this.getStatus()
        });
        this.on('change', function (item) {
          if (this.get('fullname') === undefined) {
            converse.getVCard(
                null, // No 'to' attr when getting one's own vCard
                function (iq, jid, fullname, image, image_type, url) {
                  this.save({'fullname': fullname});
                }.bind(this)
            );
          }
          if (_.has(item.changed, 'status')) {
            converse.emit('statusChanged', this.get('status'));
          }
          if (_.has(item.changed, 'status_message')) {
            converse.emit('statusMessageChanged', this.get('status_message'));
          }
        }.bind(this));
      },

      constructPresence: function (type, status_message) {
        if (typeof type === 'undefined') {
          type = this.get('status') || 'online';
        }
        if (typeof status_message === 'undefined') {
          status_message = this.get('status_message');
        }
        var presence;
        // Most of these presence types are actually not explicitly sent,
        // but I add all of them here fore reference and future proofing.
        if ((type === 'unavailable') ||
            (type === 'probe') ||
            (type === 'error') ||
            (type === 'unsubscribe') ||
            (type === 'unsubscribed') ||
            (type === 'subscribe') ||
            (type === 'subscribed')) {
          presence = $pres({'type': type});
        } else if (type === 'offline') {
          presence = $pres({'type': 'unavailable'});
          if (status_message) {
            presence.c('show').t(type);
          }
        } else {
          if (type === 'online') {
            presence = $pres();
          } else {
            presence = $pres().c('show').t(type).up();
          }
          if (status_message) {
            presence.c('status').t(status_message);
          }
        }
        return presence;
      },

      sendPresence: function (type, status_message) {
        converse.connection.send(this.constructPresence(type, status_message));
      },

      setStatus: function (value) {
        this.sendPresence(value);
        this.save({'status': value});
      },

      getStatus: function () {
        return this.get('status') || 'online';
      },

      setStatusMessage: function (status_message) {
        this.sendPresence(this.getStatus(), status_message);
        var prev_status = this.get('status_message');
        this.save({'status_message': status_message});
        if (this.xhr_custom_status) {
          $.ajax({
            url:  this.xhr_custom_status_url,
            type: 'POST',
            data: {'msg': status_message}
          });
        }
        if (prev_status === status_message) {
          this.trigger("update-status-ui", this);
        }
      }
    });

    this.Session = DS.Model; // General session settings to be saved to sessionStorage.
    this.Feature = DS.Model;
    this.Features = DS.Model.extend({
      /* Service Discovery
       * -----------------
       * This collection stores Feature Models, representing features
       * provided by available XMPP entities (e.g. servers)
       * See XEP-0030 for more details: http://xmpp.org/extensions/xep-0030.html
       * All features are shown here: http://xmpp.org/registrar/disco-features.html
       */
      content: converse.Feature,
      initialize: function () {
        this.addClientIdentities().addClientFeatures();
        this.browserStorage = new Backbone.BrowserStorage[converse.storage](
            b64_sha1('converse.features'+converse.bare_jid));
        this.on('add', this.onFeatureAdded, this);
        if (this.browserStorage.records.length === 0) {
          // browserStorage is empty, so we've likely never queried this
          // domain for features yet
          converse.connection.disco.info(converse.domain, null, this.onInfo.bind(this));
          converse.connection.disco.items(converse.domain, null, this.onItems.bind(this));
        } else {
          this.fetch({add:true});
        }
      },

      onFeatureAdded: function (feature) {
        var prefs = feature.get('preferences') || {};
        converse.emit('serviceDiscovered', feature);
        if (feature.get('var') == Strophe.NS.MAM && prefs['default'] !== converse.message_archiving) {
          // Ask the server for archiving preferences
          converse.connection.sendIQ(
              $iq({'type': 'get'}).c('prefs', {'xmlns': Strophe.NS.MAM}),
              _.bind(this.onMAMPreferences, this, feature),
              _.bind(this.onMAMError, this, feature)
          );
        }
      },

      onMAMPreferences: function (feature, iq) {
        /* Handle returned IQ stanza containing Message Archive
         * Management (XEP-0313) preferences.
         *
         * XXX: For now we only handle the global default preference.
         * The XEP also provides for per-JID preferences, which is
         * currently not supported in converse.js.
         *
         * Per JID preferences will be set in chat boxes, so it'll
         * probbaly be handled elsewhere in any case.
         */
        var $prefs = $(iq).find('prefs[xmlns="'+Strophe.NS.MAM+'"]');
        var default_pref = $prefs.attr('default');
        var stanza;
        if (default_pref !== converse.message_archiving) {
          stanza = $iq({'type': 'set'}).c('prefs', {'xmlns':Strophe.NS.MAM, 'default':converse.message_archiving});
          $prefs.children().each(function (idx, child) {
            stanza.cnode(child).up();
          });
          converse.connection.sendIQ(stanza, _.bind(function (feature, iq) {
                // XXX: Strictly speaking, the server should respond with the updated prefs
                // (see example 18: https://xmpp.org/extensions/xep-0313.html#config)
                // but Prosody doesn't do this, so we don't rely on it.
                feature.save({'preferences': {'default':converse.message_archiving}});
              }, this, feature),
              _.bind(this.onMAMError, this, feature)
          );
        } else {
          feature.save({'preferences': {'default':converse.message_archiving}});
        }
      },

      onMAMError: function (iq) {
        if ($(iq).find('feature-not-implemented').length) {
          converse.log("Message Archive Management (XEP-0313) not supported by this browser");
        } else {
          converse.log("An error occured while trying to set archiving preferences.");
          converse.log(iq);
        }
      },

      addClientIdentities: function () {
        /* See http://xmpp.org/registrar/disco-categories.html
         */
        converse.connection.disco.addIdentity('client', 'web', 'Converse.js');
        return this;
      },

      addClientFeatures: function () {
        /* The strophe.disco.js plugin keeps a list of features which
         * it will advertise to any #info queries made to it.
         *
         * See: http://xmpp.org/extensions/xep-0030.html#info
         */
        converse.connection.disco.addFeature('jabber:x:conference');
        converse.connection.disco.addFeature(Strophe.NS.BOSH);
        converse.connection.disco.addFeature(Strophe.NS.CHATSTATES);
        converse.connection.disco.addFeature(Strophe.NS.DISCO_INFO);
        converse.connection.disco.addFeature(Strophe.NS.MAM);
        converse.connection.disco.addFeature(Strophe.NS.ROSTERX); // Limited support
        if (converse.use_vcards) {
          converse.connection.disco.addFeature(Strophe.NS.VCARD);
        }
        if (converse.allow_muc) {
          converse.connection.disco.addFeature(Strophe.NS.MUC);
        }
        if (converse.message_carbons) {
          converse.connection.disco.addFeature(Strophe.NS.CARBONS);
        }
        return this;
      },

      onItems: function (stanza) {
        $(stanza).find('query item').each(function (idx, item) {
          converse.connection.disco.info(
              $(item).attr('jid'),
              null,
              this.onInfo.bind(this));
        }.bind(this));
      },

      onInfo: function (stanza) {
        var $stanza = $(stanza);
        if (($stanza.find('identity[category=server][type=im]').length === 0) &&
            ($stanza.find('identity[category=conference][type=text]').length === 0)) {
          // This isn't an IM server component
          return;
        }
        $stanza.find('feature').each(function (idx, feature) {
          var namespace = $(feature).attr('var');
          this[namespace] = true;
          this.create({
            'var': namespace,
            'from': $stanza.attr('from')
          });
        }.bind(this));
      }
    });


    this.addControlBox = function () {

      // creaate the first interface


      //return this.chatboxes.add({
      //  id: 'controlbox',
      //  box_id: 'controlbox',
      //  closed: !this.show_controlbox_by_default
      //});
    };

    this.setUpXMLLogging = function () {
      if (this.debug) {
        this.connection.xmlInput = function (body) { console.log(body.outerHTML); };
        this.connection.xmlOutput = function (body) { console.log(body.outerHTML); };
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
          converse.log("Could not restore session for jid: "+this.jid+" Error message: "+e.message);
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
          converse.log("Could not restore sessions. Error message: "+e.message);
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
      this.chatboxes = new this.ChatBoxes();
      //this.chatboxviews = new this.ChatBoxViews({model: this.chatboxes});
      //this.controlboxtoggle = new this.ControlBoxToggle();
      this.otr = new this.OTR();
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
          if (typeof override == "object") {
            this._extendObject(converse[key], override);
          } else {
            this._overrideAttribute(key, plugin);
          }
        }.bind(this));
        /*
         if (typeof plugin.initialize === "function") {
         plugin.initialize.bind(plugin)(this);
         } else {
         // This will be deprecated in 0.10
         plugin.bind(this)(this);
         }*/
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

  var API = {
    'initialize': function (settings, callback) {
      converse.initialize(settings, callback);
    },
    'disconnect': function () {
      converse.connection.disconnect();
    },
    'account': {
      // XXX: Deprecated, will be removed with next non-minor release
      'logout': function () {
        converse.logOut();
      }
    },
    'user': {
      'logout': function () {
        converse.logOut();
      },
      'status': {
        'get': function () {
          return converse.xmppstatus.get('status');
        },
        'set': function (value, message) {
          var data = {'status': value};
          if (!_.contains(_.keys(STATUS_WEIGHTS), value)) {
            throw new Error('Invalid availability value. See https://xmpp.org/rfcs/rfc3921.html#rfc.section.2.2.2.1');
          }
          if (typeof message == "string") {
            data.status_message = message;
          }
          converse.xmppstatus.save(data);
        },
        'message': {
          'get': function () {
            return converse.xmppstatus.get('status_message');
          },
          'set': function (stat) {
            converse.xmppstatus.save({'status_message': stat});
          }
        }
      },
    },
    'settings': {
      'get': function (key) {
        if (_.contains(Object.keys(converse.default_settings), key)) {
          return converse[key];
        }
      },
      'set': function (key, val) {
        var o = {};
        if (typeof key === "object") {
          _.extend(converse, _.pick(key, Object.keys(converse.default_settings)));
        } else if (typeof key === "string") {
          o[key] = val;
          _.extend(converse, _.pick(o, Object.keys(converse.default_settings)));
        }
      }
    },
    'contacts': {
      'get': function (jids) {
        var _transform = function (jid) {
          var contact = converse.roster.get(Strophe.getBareJidFromJid(jid));
          if (contact) {
            return contact.attributes;
          }
          return null;
        };
        if (typeof jids === "undefined") {
          jids = converse.roster.pluck('jid');
        } else if (typeof jids === "string") {
          return _transform(jids);
        }
        return _.map(jids, _transform);
      },
      'add': function (jid, name) {
        if (typeof jid !== "string" || jid.indexOf('@') < 0) {
          throw new TypeError('contacts.add: invalid jid');
        }
        converse.roster.addAndSubscribe(jid, _.isEmpty(name)? jid: name);
      }
    },
    'chats': {
      'open': function (jids) {
        var chatbox;
        if (typeof jids === "undefined") {
          converse.log("chats.open: You need to provide at least one JID", "error");
          return null;
        } else if (typeof jids === "string") {
          chatbox = wrappedChatBox(converse.chatboxes.getChatBox(jids, true));
          chatbox.open();
          return chatbox;
        }
        return _.map(jids, function (jid) {
          chatbox = wrappedChatBox(converse.chatboxes.getChatBox(jid, true));
          chatbox.open();
          return chatbox;
        });
      },
      'get': function (jids) {
        if (typeof jids === "undefined") {
          converse.log("chats.get: You need to provide at least one JID", "error");
          return null;
        } else if (typeof jids === "string") {
          return wrappedChatBox(converse.chatboxes.getChatBox(jids, true));
        }
        return _.map(jids, _.partial(_.compose(wrappedChatBox, converse.chatboxes.getChatBox.bind(converse.chatboxes)), _, true));
      }
    },
    'archive': {
      'query': function (options, callback, errback) {
        /* Do a MAM (XEP-0313) query for archived messages.
         *
         * Parameters:
         *    (Object) options - Query parameters, either MAM-specific or also for Result Set Management.
         *    (Function) callback - A function to call whenever we receive query-relevant stanza.
         *    (Function) errback - A function to call when an error stanza is received.
         *
         * The options parameter can also be an instance of
         * Strophe.RSM to enable easy querying between results pages.
         *
         * The callback function may be called multiple times, first
         * for the initial IQ result and then for each message
         * returned. The last time the callback is called, a
         * Strophe.RSM object is returned on which "next" or "previous"
         * can be called before passing it in again to this method, to
         * get the next or previous page in the result set.
         */
        var date, messages = [];
        if (typeof options == "function") {
          callback = options;
          errback = callback;
        }
        if (!converse.features.findWhere({'var': Strophe.NS.MAM})) {
          throw new Error('This server does not support XEP-0313, Message Archive Management');
        }
        var queryid = converse.connection.getUniqueId();
        var attrs = {'type':'set'};
        if (typeof options != "undefined" && options.groupchat) {
          if (!options['with']) {
            throw new Error('You need to specify a "with" value containing the chat room JID, when querying groupchat messages.');
          }
          attrs.to = options['with'];
        }
        var stanza = $iq(attrs).c('query', {'xmlns':Strophe.NS.MAM, 'queryid':queryid});
        if (typeof options != "undefined") {
          stanza.c('x', {'xmlns':Strophe.NS.XFORM, 'type': 'submit'})
              .c('field', {'var':'FORM_TYPE', 'type': 'hidden'})
              .c('value').t(Strophe.NS.MAM).up().up();

          if (options['with'] && !options.groupchat) {
            stanza.c('field', {'var':'with'}).c('value').t(options['with']).up().up();
          }
          _.each(['start', 'end'], function (t) {
            if (options[t]) {
              date = moment(options[t]);
              if (date.isValid()) {
                stanza.c('field', {'var':t}).c('value').t(date.format()).up().up();
              } else {
                throw new TypeError('archive.query: invalid date provided for: '+t);
              }
            }
          });
          stanza.up();
          if (options instanceof Strophe.RSM) {
            stanza.cnode(options.toXML());
          } else if (_.intersection(RSM_ATTRIBUTES, _.keys(options)).length) {
            stanza.cnode(new Strophe.RSM(options).toXML());
          }
        }
        converse.connection.addHandler(function (message) {
          var $msg = $(message), $fin, rsm, i;
          if (typeof callback == "function") {
            $fin = $msg.find('fin[xmlns="'+Strophe.NS.MAM+'"]');
            if ($fin.length) {
              rsm = new Strophe.RSM({xml: $fin.find('set')[0]});
              _.extend(rsm, _.pick(options, ['max']));
              _.extend(rsm, _.pick(options, MAM_ATTRIBUTES));
              callback(messages, rsm);
              return false; // We've received all messages, decommission this handler
            } else if (queryid == $msg.find('result').attr('queryid')) {
              messages.push(message);
            }
            return true;
          } else {
            return false; // There's no callback, so no use in continuing this handler.
          }
        }, Strophe.NS.MAM);
        converse.connection.sendIQ(stanza, null, errback);
      }
    },
    'rooms': {
      'open': function (jids, nick) {
        if (!nick) {
          nick = Strophe.getNodeFromJid(converse.bare_jid);
        }
        if (typeof nick !== "string") {
          throw new TypeError('rooms.open: invalid nick, must be string');
        }
        var _transform = function (jid) {
          var chatroom = converse.chatboxes.get(jid);
          converse.log('jid');
          if (!chatroom) {
            chatroom = converse.chatboxviews.showChat({
              'id': jid,
              'jid': jid,
              'name': Strophe.unescapeNode(Strophe.getNodeFromJid(jid)),
              'nick': nick,
              'chatroom': true,
              'box_id' : b64_sha1(jid)
            });
          }
          return wrappedChatBox(converse.chatboxes.getChatBox(chatroom, true));
        };
        if (typeof jids === "undefined") {
          throw new TypeError('rooms.open: You need to provide at least one JID');
        } else if (typeof jids === "string") {
          return _transform(jids);
        }
        return _.map(jids, _transform);
      },
      'get': function (jids) {
        if (typeof jids === "undefined") {
          throw new TypeError("rooms.get: You need to provide at least one JID");
        } else if (typeof jids === "string") {
          return wrappedChatBox(converse.chatboxes.getChatBox(jids, true));
        }
        return _.map(jids, _.partial(wrappedChatBox, _.bind(converse.chatboxes.getChatBox, converse.chatboxes, _, true)));

      }
    },
    'tokens': {
      'get': function (id) {
        if (!converse.expose_rid_and_sid || typeof converse.connection === "undefined") {
          return null;
        }
        if (id.toLowerCase() === 'rid') {
          return converse.connection.rid || converse.connection._proto.rid;
        } else if (id.toLowerCase() === 'sid') {
          return converse.connection.sid || converse.connection._proto.sid;
        }
      }
    },
    'listen': {
      'once': function (evt, handler) {
        converse.once(evt, handler);
      },
      'on': function (evt, handler) {
        converse.on(evt, handler);
      },
      'not': function (evt, handler) {
        converse.off(evt, handler);
      },
    },
    'send': function (stanza) {
      converse.connection.send(stanza);
    },
    'ping': function (jid) {
      converse.ping(jid);
    },
    'plugins': {
      'add': function (name, plugin) {
        converse.plugins[name] = plugin;
      },
      'remove': function (name) {
        delete converse.plugins[name];
      },
      'override': function (name, value) {
        /* Helper method for overriding methods and attributes directly on the
         * converse object. For Backbone objects, use instead the 'extend'
         * method.
         *
         * If a method is overridden, then the original method will still be
         * available via the _super attribute.
         *
         * name: The attribute being overridden.
         * value: The value of the attribute being overridden.
         */
        converse._overrideAttribute(name, value);
      },
      'extend': function (obj, attributes) {
        /* Helper method for overriding or extending Converse's Backbone Views or Models
         *
         * When a method is overriden, the original will still be available
         * on the _super attribute of the object being overridden.
         *
         * obj: The Backbone View or Model
         * attributes: A hash of attributes, such as you would pass to DS.Model.extend or Backbone.View.extend
         */
        converse._extendObject(obj, attributes);
      }
    },
    'env': {
      '$build': $build,
      '$iq': $iq,
      '$msg': $msg,
      '$pres': $pres,
      'Strophe': Strophe,
      '_': _,
      'b64_sha1':  b64_sha1,
      'jQuery': $,
      'moment': moment
    }
  };
  return API;
}));
