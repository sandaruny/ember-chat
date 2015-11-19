/**
 * Created by sandaruwan on 11/13/15.
 */
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

  //var contains = function (attr, query) {
  //  return function (item) {
  //    if (typeof attr === 'object') {
  //      var value = false;
  //      _.each(attr, function (a) {
  //        value = value || item.get(a).toLowerCase().indexOf(query.toLowerCase()) !== -1;
  //      });
  //      return value;
  //    } else if (typeof attr === 'string') {
  //      return item.get(attr).toLowerCase().indexOf(query.toLowerCase()) !== -1;
  //    } else {
  //      throw new TypeError('contains: wrong attribute type. Must be string or array.');
  //    }
  //  };
  //};
  //contains.not = function (attr, query) {
  //  return function (item) {
  //    return !(contains(attr, query)(item));
  //  };
  //};
  //
  //// XXX: these can perhaps be moved to src/polyfills.js
  //String.prototype.splitOnce = function (delimiter) {
  //  var components = this.split(delimiter);
  //  return [components.shift(), components.join(delimiter)];
  //};
  //
  //var converse = {
  //  plugins: {},
  //  templates: templates,
  //  emit: function (evt, data) {
  //    $(this).trigger(evt, data);
  //  },
  //  once: function (evt, handler) {
  //    $(this).one(evt, handler);
  //  },
  //  on: function (evt, handler) {
  //    $(this).bind(evt, handler);
  //  },
  //  off: function (evt, handler) {
  //    $(this).unbind(evt, handler);
  //  },
  //  refreshWebkit: function () {
  //    /* This works around a webkit bug. Refresh the browser's viewport,
  //     * otherwise chatboxes are not moved along when one is closed.
  //     */
  //    if ($.browser.webkit) {
  //      var conversejs = document.getElementById('conversejs');
  //      conversejs.style.display = 'none';
  //      conversejs.offsetHeight = conversejs.offsetHeight;
  //      conversejs.style.display = 'block';
  //    }
  //  }
  //};

  // Global constants

  //// XEP-0059 Result Set Management
  //var RSM_ATTRIBUTES = ['max', 'first', 'last', 'after', 'before', 'index', 'count'];
  //// XEP-0313 Message Archive Management
  //var MAM_ATTRIBUTES = ['with', 'start', 'end'];
  //
  //var STATUS_WEIGHTS = {
  //  'offline':      6,
  //  'unavailable':  5,
  //  'xa':           4,
  //  'away':         3,
  //  'dnd':          2,
  //  'chat':         1, // We currently don't differentiate between "chat" and "online"
  //  'online':       1
  //};

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

    this.store = function(){
      return{



      }
    }


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
      this.session.browserStorage = new Backbone.BrowserStorage[converse.storage](id);

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

    //this.store = DS.Store.extend({
    //
    //});




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
