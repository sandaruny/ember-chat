// Backbone Models and Views
// -------------------------
this.OTR = Backbone.Model.extend({
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

  generatePrivateKey: function (instance_tag) {
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

this.Message = Backbone.Model.extend({
  idAttribute: 'msgid',
  defaults: function(){
    return {
      msgid: converse.connection.getUniqueId()
    };
  }
});
this.Messages = Backbone.Collection.extend({
  model: converse.Message,
  comparator: 'time'
});

this.ChatBox = Backbone.Model.extend({

  initialize: function () {
    var height = this.get('height'),
      width = this.get('width'),
      settings = {
        'height': converse.applyDragResistance(height, this.get('default_height')),
        'width': converse.applyDragResistance(width, this.get('default_width')),
        'num_unread': this.get('num_unread') || 0
      };
    if (this.get('box_id') !== 'controlbox') {
      this.messages = new converse.Messages();
      this.messages.browserStorage = new Backbone.BrowserStorage[converse.storage](
        b64_sha1('converse.messages'+this.get('jid')+converse.bare_jid));
      this.save(_.extend(settings, {
        // The chat_state will be set to ACTIVE once the chat box is opened
        // and we listen for change:chat_state, so shouldn't set it to ACTIVE here.
        'chat_state': undefined,
        'box_id' : b64_sha1(this.get('jid')),
        'minimized': this.get('minimized') || false,
        'otr_status': this.get('otr_status') || UNENCRYPTED,
        'time_minimized': this.get('time_minimized') || moment(),
        'time_opened': this.get('time_opened') || moment().valueOf(),
        'url': '',
        'user_id' : Strophe.getNodeFromJid(this.get('jid'))
      }));
    } else {
      this.set(_.extend(settings, { 'time_opened': moment(0).valueOf() }));
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
    var pass, instance_tag, saved_key, pass_check;
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
      var instance_tag = OTR.makeInstanceTag();
      callback({
        'key': converse.otr.generatePrivateKey.call(this, instance_tag),
        'instance_tag': instance_tag
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
    this.getSession(function (session) {
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
        this.trigger('sendMessage', new converse.Message({ message: msg }));
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
    if ((is_groupchat && from === this.get('nick')) || (!is_groupchat && from === converse.bare_jid)) {
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
          // Normal unencrypted message.
          this.createMessage($message, $delay, archive_id);
        }
      }
    }
  }
});

this.ChatBoxView = Backbone.View.extend({
  length: 200,
  tagName: 'div',
  className: 'chatbox',
  is_chatroom: false,  // This is not a multi-user chatroom

  events: {
    'click .close-chatbox-button': 'close',
    'click .toggle-chatbox-button': 'minimize',
    'keypress textarea.chat-textarea': 'keyPressed',
    'click .toggle-smiley': 'toggleEmoticonMenu',
    'click .toggle-smiley ul li': 'insertEmoticon',
    'click .toggle-clear': 'clearMessages',
    'click .toggle-otr': 'toggleOTRMenu',
    'click .start-otr': 'startOTRFromToolbar',
    'click .end-otr': 'endOTR',
    'click .auth-otr': 'authOTR',
    'click .toggle-call': 'toggleCall',
    'mousedown .dragresize-top': 'onStartVerticalResize',
    'mousedown .dragresize-left': 'onStartHorizontalResize',
    'mousedown .dragresize-topleft': 'onStartDiagonalResize'
  },

  initialize: function () {
    $(window).on('resize', _.debounce(this.setDimensions.bind(this), 100));
    this.model.messages.on('add', this.onMessageAdded, this);
    this.model.on('show', this.show, this);
    this.model.on('destroy', this.hide, this);
    // TODO check for changed fullname as well
    this.model.on('change:chat_state', this.sendChatState, this);
    this.model.on('change:chat_status', this.onChatStatusChanged, this);
    this.model.on('change:image', this.renderAvatar, this);
    this.model.on('change:otr_status', this.onOTRStatusChanged, this);
    this.model.on('change:minimized', this.onMinimizedChanged, this);
    this.model.on('change:status', this.onStatusChanged, this);
    this.model.on('showOTRError', this.showOTRError, this);
    this.model.on('showHelpMessages', this.showHelpMessages, this);
    this.model.on('sendMessage', this.sendMessage, this);
    this.model.on('showSentOTRMessage', function (text) {
      this.showMessage({'message': text, 'sender': 'me'});
    }, this);
    this.model.on('showReceivedOTRMessage', function (text) {
      this.showMessage({'message': text, 'sender': 'them'});
    }, this);
    this.updateVCard().render().fetchMessages().insertIntoPage().hide();

    if ((_.contains([UNVERIFIED, VERIFIED], this.model.get('otr_status'))) || converse.use_otr_by_default) {
      this.model.initiateOTR();
    }
  },

  render: function () {
    this.$el.attr('id', this.model.get('box_id'))
      .html(converse.templates.chatbox(
        _.extend(this.model.toJSON(), {
            show_toolbar: converse.show_toolbar,
            info_close: __('Close this chat box'),
            info_minimize: __('Minimize this chat box'),
            info_view: __('View more information on this person'),
            label_personal_message: __('Personal message')
          }
        )
      )
    );
    this.setWidth();
    this.$content = this.$el.find('.chat-content');
    this.renderToolbar().renderAvatar();
    this.$content.on('scroll', _.debounce(this.onScroll.bind(this), 100));
    converse.emit('chatBoxOpened', this);
    setTimeout(converse.refreshWebkit, 50);
    return this.showStatusMessage();
  },

  setWidth: function () {
    // If a custom width is applied (due to drag-resizing),
    // then we need to set the width of the .chatbox element as well.
    if (this.model.get('width')) {
      this.$el.css('width', this.model.get('width'));
    }
  },

  onScroll: function (ev) {
    if ($(ev.target).scrollTop() === 0 && this.model.messages.length) {
      this.fetchArchivedMessages({
        'before': this.model.messages.at(0).get('archive_id'),
        'with': this.model.get('jid'),
        'max': converse.archived_messages_page_size
      });
    }
  },

  fetchMessages: function () {
    /* Responsible for fetching previously sent messages, first
     * from session storage, and then once that's done by calling
     * fetchArchivedMessages, which fetches from the XMPP server if
     * applicable.
     */
    this.model.messages.fetch({
      'add': true,
      'success': function () {
        if (!converse.features.findWhere({'var': Strophe.NS.MAM})) {
          return;
        }
        if (this.model.messages.length < converse.archived_messages_page_size) {
          this.fetchArchivedMessages({
            'before': '', // Page backwards from the most recent message
            'with': this.model.get('jid'),
            'max': converse.archived_messages_page_size
          });
        }
      }.bind(this)
    });
    return this;
  },

  fetchArchivedMessages: function (options) {
    /* Fetch archived chat messages from the XMPP server.
     *
     * Then, upon receiving them, call onMessage on the chat box,
     * so that they are displayed inside it.
     */
    if (!converse.features.findWhere({'var': Strophe.NS.MAM})) {
      converse.log("Attempted to fetch archived messages but this user's server doesn't support XEP-0313");
      return;
    }
    this.addSpinner();
    API.archive.query(_.extend(options, {'groupchat': this.is_chatroom}),
      function (messages) {
        this.clearSpinner();
        if (messages.length) {
          if (this.is_chatroom) {
            _.map(messages, this.onChatRoomMessage.bind(this));
          } else {
            _.map(messages, converse.chatboxes.onMessage.bind(converse.chatboxes));
          }
        }
      }.bind(this),
      function () {
        this.clearSpinner();
        converse.log("Error while trying to fetch archived messages", "error");
      }.bind(this)
    );
  },

  insertIntoPage: function () {
    this.$el.insertAfter(converse.chatboxviews.get("controlbox").$el);
    return this;
  },

  adjustToViewport: function () {
    /* Event handler called when viewport gets resized. We remove
     * custom width/height from chat boxes.
     */
    var viewport_width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    var viewport_height = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    if (viewport_width <= 480) {
      this.model.set('height', undefined);
      this.model.set('width', undefined);
    } else if (viewport_width <= this.model.get('width')) {
      this.model.set('width', undefined);
    } else if (viewport_height <= this.model.get('height')) {
      this.model.set('height', undefined);
    }
  },

  initDragResize: function () {
    /* Determine and store the default box size.
     * We need this information for the drag-resizing feature.
     */
    var $flyout = this.$el.find('.box-flyout');
    if (typeof this.model.get('height') === 'undefined') {
      var height = $flyout.height();
      var width = $flyout.width();
      this.model.set('height', height);
      this.model.set('default_height', height);
      this.model.set('width', width);
      this.model.set('default_width', width);
    }
    var min_width = $flyout.css('min-width');
    var min_height = $flyout.css('min-height');
    this.model.set('min_width', min_width.endsWith('px') ? Number(min_width.replace(/px$/, '')) :0);
    this.model.set('min_height', min_height.endsWith('px') ? Number(min_height.replace(/px$/, '')) :0);
    // Initialize last known mouse position
    this.prev_pageY = 0;
    this.prev_pageX = 0;
    if (converse.connection.connected) {
      this.height = this.model.get('height');
      this.width = this.model.get('width');
    }
    return this;
  },

  setDimensions: function () {
    // Make sure the chat box has the right height and width.
    this.adjustToViewport();
    this.setChatBoxHeight(this.model.get('height'));
    this.setChatBoxWidth(this.model.get('width'));
  },

  clearStatusNotification: function () {
    this.$content.find('div.chat-event').remove();
  },

  showStatusNotification: function (message, keep_old) {
    if (!keep_old) {
      this.clearStatusNotification();
    }
    this.$content.append($('<div class="chat-info chat-event"></div>').text(message));
    this.scrollDown();
  },

  clearChatRoomMessages: function (ev) {
    if (typeof ev !== "undefined") { ev.stopPropagation(); }
    var result = confirm(__("Are you sure you want to clear the messages from this room?"));
    if (result === true) {
      this.$content.empty();
    }
    return this;
  },

  addSpinner: function () {
    if (!this.$content.first().hasClass('spinner')) {
      this.$content.prepend('<span class="spinner"/>');
    }
  },

  clearSpinner: function () {
    if (this.$content.children(':first').is('span.spinner')) {
      this.$content.children(':first').remove();
    }
  },

  prependDayIndicator: function (date) {
    /* Prepends an indicator into the chat area, showing the day as
     * given by the passed in date.
     *
     * Parameters:
     *  (String) date - An ISO8601 date string.
     */
    var day_date = moment(date).startOf('day');
    this.$content.prepend(converse.templates.new_day({
      isodate: day_date.format(),
      datestring: day_date.format("dddd MMM Do YYYY")
    }));
  },

  appendMessage: function (attrs) {
    /* Helper method which appends a message to the end of the chat
     * box's content area.
     *
     * Parameters:
     *  (Object) attrs: An object containing the message attributes.
     */
    _.compose(
      _.debounce(this.scrollDown.bind(this), 50),
      this.$content.append.bind(this.$content)
    )(this.renderMessage(attrs));
  },

  showMessage: function (attrs) {
    /* Inserts a chat message into the content area of the chat box.
     * Will also insert a new day indicator if the message is on a
     * different day.
     *
     * The message to show may either be newer than the newest
     * message, or older than the oldest message.
     *
     * Parameters:
     *  (Object) attrs: An object containing the message attributes.
     */
    var $first_msg = this.$content.children('.chat-message:first'),
      first_msg_date = $first_msg.data('isodate'),
      last_msg_date, current_msg_date, day_date, $msgs, msg_dates, idx;
    if (!first_msg_date) {
      this.appendMessage(attrs);
      return;
    }
    current_msg_date = moment(attrs.time) || moment;
    last_msg_date = this.$content.children('.chat-message:last').data('isodate');

    if (typeof last_msg_date !== "undefined" && (current_msg_date.isAfter(last_msg_date) || current_msg_date.isSame(last_msg_date))) {
      // The new message is after the last message
      if (current_msg_date.isAfter(last_msg_date, 'day')) {
        // Append a new day indicator
        day_date = moment(current_msg_date).startOf('day');
        this.$content.append(converse.templates.new_day({
          isodate: current_msg_date.format(),
          datestring: current_msg_date.format("dddd MMM Do YYYY")
        }));
      }
      this.appendMessage(attrs);
      return;
    }

    if (typeof first_msg_date !== "undefined" &&
      (current_msg_date.isBefore(first_msg_date) ||
      (current_msg_date.isSame(first_msg_date) && !current_msg_date.isSame(last_msg_date)))) {
      // The new message is before the first message

      if ($first_msg.prev().length === 0) {
        // There's no day indicator before the first message, so we prepend one.
        this.prependDayIndicator(first_msg_date);
      }
      if (current_msg_date.isBefore(first_msg_date, 'day')) {
        _.compose(
          this.scrollDownMessageHeight.bind(this),
          function ($el) {
            this.$content.prepend($el);
            return $el;
          }.bind(this)
        )(this.renderMessage(attrs));
        // This message is on a different day, so we add a day indicator.
        this.prependDayIndicator(current_msg_date);
      } else {
        // The message is before the first, but on the same day.
        // We need to prepend the message immediately before the
        // first message (so that it'll still be after the day indicator).
        _.compose(
          this.scrollDownMessageHeight.bind(this),
          function ($el) {
            $el.insertBefore($first_msg);
            return $el;
          }
        )(this.renderMessage(attrs));
      }
    } else {
      // We need to find the correct place to position the message
      current_msg_date = current_msg_date.format();
      $msgs = this.$content.children('.chat-message');
      msg_dates = _.map($msgs, function (el) {
        return $(el).data('isodate');
      });
      msg_dates.push(current_msg_date);
      msg_dates.sort();
      idx = msg_dates.indexOf(current_msg_date)-1;
      _.compose(
        this.scrollDownMessageHeight.bind(this),
        function ($el) {
          $el.insertAfter(this.$content.find('.chat-message[data-isodate="'+msg_dates[idx]+'"]'));
          return $el;
        }.bind(this)
      )(this.renderMessage(attrs));
    }
  },

  renderMessage: function (attrs) {
    /* Renders a chat message based on the passed in attributes.
     *
     * Parameters:
     *  (Object) attrs: An object containing the message attributes.
     *
     *  Returns:
     *      The DOM element representing the message.
     */
    var msg_time = moment(attrs.time) || moment,
      text = attrs.message,
      match = text.match(/^\/(.*?)(?: (.*))?$/),
      fullname = this.model.get('fullname') || attrs.fullname,
      extra_classes = attrs.delayed && 'delayed' || '',
      template, username;

    if ((match) && (match[1] === 'me')) {
      text = text.replace(/^\/me/, '');
      template = converse.templates.action;
      username = fullname;
    } else  {
      template = converse.templates.message;
      username = attrs.sender === 'me' && __('me') || fullname;
    }
    this.$content.find('div.chat-event').remove();

    if (this.is_chatroom && attrs.sender === 'them' && (new RegExp("\\b"+this.model.get('nick')+"\\b")).test(text)) {
      // Add special class to mark groupchat messages in which we
      // are mentioned.
      extra_classes += ' mentioned';
    }
    return $(template({
      msgid: attrs.msgid,
      'sender': attrs.sender,
      'time': msg_time.format('hh:mm'),
      'isodate': msg_time.format(),
      'username': username,
      'message': '',
      'extra_classes': extra_classes
    })).children('.chat-msg-content').first().text(text)
      .addHyperlinks()
      .addEmoticons(converse.visible_toolbar_buttons.emoticons).parent();
  },

  showHelpMessages: function (msgs, type, spinner) {
    var i, msgs_length = msgs.length;
    for (i=0; i<msgs_length; i++) {
      this.$content.append($('<div class="chat-'+(type||'info')+'">'+msgs[i]+'</div>'));
    }
    if (spinner === true) {
      this.$content.append('<span class="spinner"/>');
    } else if (spinner === false) {
      this.$content.find('span.spinner').remove();
    }
    return this.scrollDown();
  },

  onMessageAdded: function (message) {
    /* Handler that gets called when a new message object is created.
     *
     * Parameters:
     *    (Object) message - The message Backbone object that was added.
     */
    if (typeof this.clear_status_timeout !== 'undefined') {
      clearTimeout(this.clear_status_timeout);
      delete this.clear_status_timeout;
    }
    if (!message.get('message')) {
      if (message.get('chat_state') === COMPOSING) {
        this.showStatusNotification(message.get('fullname')+' '+__('is typing'));
        this.clear_status_timeout = setTimeout(this.clearStatusNotification.bind(this), 10000);
        return;
      } else if (message.get('chat_state') === PAUSED) {
        this.showStatusNotification(message.get('fullname')+' '+__('has stopped typing'));
        return;
      } else if (_.contains([INACTIVE, ACTIVE], message.get('chat_state'))) {
        this.$content.find('div.chat-event').remove();
        return;
      } else if (message.get('chat_state') === GONE) {
        this.showStatusNotification(message.get('fullname')+' '+__('has gone away'));
        return;
      }
    } else {
      this.showMessage(_.clone(message.attributes));
    }
    if ((message.get('sender') !== 'me') && (converse.windowState === 'blur')) {
      converse.incrementMsgCounter();
    }
    if (!this.model.get('minimized') && !this.$el.is(':visible')) {
      _.debounce(this.show.bind(this), 100)();
    }
  },

  sendMessage: function (message) {
    /* Responsible for sending off a text message.
     *
     *  Parameters:
     *    (Message) message - The chat message
     */
    // TODO: We might want to send to specfic resources. Especially in the OTR case.
    var bare_jid = this.model.get('jid');
    var messageStanza = $msg({from: converse.connection.jid, to: bare_jid, type: 'chat', id: message.get('msgid')})
      .c('body').t(message.get('message')).up()
      .c(ACTIVE, {'xmlns': Strophe.NS.CHATSTATES}).up();

    if (this.model.get('otr_status') !== UNENCRYPTED) {
      // OTR messages aren't carbon copied
      messageStanza.c('private', {'xmlns': Strophe.NS.CARBONS});
    }
    converse.connection.send(messageStanza);
    if (converse.forward_messages) {
      // Forward the message, so that other connected resources are also aware of it.
      converse.connection.send(
        $msg({ to: converse.bare_jid, type: 'chat', id: message.get('msgid') })
          .c('forwarded', {xmlns:'urn:xmpp:forward:0'})
          .c('delay', {xmns:'urn:xmpp:delay',stamp:(new Date()).getTime()}).up()
          .cnode(messageStanza.tree())
      );
    }
  },

  onMessageSubmitted: function (text) {
    /* This method gets called once the user has typed a message
     * and then pressed enter in a chat box.
     *
     *  Parameters:
     *    (string) text - The chat message text.
     */
    if (!converse.connection.authenticated) {
      return this.showHelpMessages(['Sorry, the connection has been lost, and your message could not be sent'], 'error');
    }
    var match = text.replace(/^\s*/, "").match(/^\/(.*)\s*$/), msgs;
    if (match) {
      if (match[1] === "clear") {
        return this.clearMessages();
      }
      else if (match[1] === "help") {
        msgs = [
          '<strong>/help</strong>:'+__('Show this menu')+'',
          '<strong>/me</strong>:'+__('Write in the third person')+'',
          '<strong>/clear</strong>:'+__('Remove messages')+''
        ];
        this.showHelpMessages(msgs);
        return;
      } else if ((converse.allow_otr) && (match[1] === "endotr")) {
        return this.endOTR();
      } else if ((converse.allow_otr) && (match[1] === "otr")) {
        return this.model.initiateOTR();
      }
    }
    if (_.contains([UNVERIFIED, VERIFIED], this.model.get('otr_status'))) {
      // Off-the-record encryption is active
      this.model.otr.sendMsg(text);
      this.model.trigger('showSentOTRMessage', text);
    } else {
      // We only save unencrypted messages.
      var fullname = converse.xmppstatus.get('fullname');
      fullname = _.isEmpty(fullname)? converse.bare_jid: fullname;
      var message = this.model.messages.create({
        fullname: fullname,
        sender: 'me',
        time: moment().format(),
        message: text
      });
      this.sendMessage(message);
    }
  },

  sendChatState: function () {
    /* Sends a message with the status of the user in this chat session
     * as taken from the 'chat_state' attribute of the chat box.
     * See XEP-0085 Chat State Notifications.
     */
    converse.connection.send(
      $msg({'to':this.model.get('jid'), 'type': 'chat'})
        .c(this.model.get('chat_state'), {'xmlns': Strophe.NS.CHATSTATES})
    );
  },

  setChatState: function (state, no_save) {
    /* Mutator for setting the chat state of this chat session.
     * Handles clearing of any chat state notification timeouts and
     * setting new ones if necessary.
     * Timeouts are set when the  state being set is COMPOSING or PAUSED.
     * After the timeout, COMPOSING will become PAUSED and PAUSED will become INACTIVE.
     * See XEP-0085 Chat State Notifications.
     *
     *  Parameters:
     *    (string) state - The chat state (consts ACTIVE, COMPOSING, PAUSED, INACTIVE, GONE)
     *    (Boolean) no_save - Just do the cleanup or setup but don't actually save the state.
     */
    if (typeof this.chat_state_timeout !== 'undefined') {
      clearTimeout(this.chat_state_timeout);
      delete this.chat_state_timeout;
    }
    if (state === COMPOSING) {
      this.chat_state_timeout = setTimeout(
        this.setChatState.bind(this), converse.TIMEOUTS.PAUSED, PAUSED);
    } else if (state === PAUSED) {
      this.chat_state_timeout = setTimeout(
        this.setChatState.bind(this), converse.TIMEOUTS.INACTIVE, INACTIVE);
    }
    if (!no_save && this.model.get('chat_state') !== state) {
      this.model.set('chat_state', state);
    }
    return this;
  },

  keyPressed: function (ev) {
    /* Event handler for when a key is pressed in a chat box textarea.
     */
    var $textarea = $(ev.target), message;
    if (ev.keyCode === KEY.ENTER) {
      ev.preventDefault();
      message = $textarea.val();
      $textarea.val('').focus();
      if (message !== '') {
        if (this.model.get('chatroom')) {
          this.onChatRoomMessageSubmitted(message);
        } else {
          this.onMessageSubmitted(message);
        }
        converse.emit('messageSend', message);
      }
      this.setChatState(ACTIVE);
    } else if (!this.model.get('chatroom')) { // chat state data is currently only for single user chat
      // Set chat state to composing if keyCode is not a forward-slash
      // (which would imply an internal command and not a message).
      this.setChatState(COMPOSING, ev.keyCode === KEY.FORWARD_SLASH);
    }
  },

  onStartVerticalResize: function (ev) {
    if (!converse.allow_dragresize) { return true; }
    // Record element attributes for mouseMove().
    this.height = this.$el.children('.box-flyout').height();
    converse.resizing = {
      'chatbox': this,
      'direction': 'top'
    };
    this.prev_pageY = ev.pageY;
  },

  onStartHorizontalResize: function (ev) {
    if (!converse.allow_dragresize) { return true; }
    this.width = this.$el.children('.box-flyout').width();
    converse.resizing = {
      'chatbox': this,
      'direction': 'left'
    };
    this.prev_pageX = ev.pageX;
  },

  onStartDiagonalResize: function (ev) {
    this.onStartHorizontalResize(ev);
    this.onStartVerticalResize(ev);
    converse.resizing.direction = 'topleft';
  },

  setChatBoxHeight: function (height) {
    if (!this.model.get('minimized')) {
      if (height) {
        height = converse.applyDragResistance(height, this.model.get('default_height'))+'px';
      } else {
        height = "";
      }
      this.$el.children('.box-flyout')[0].style.height = height;
    }
  },

  setChatBoxWidth: function (width) {
    if (!this.model.get('minimized')) {
      if (width) {
        width = converse.applyDragResistance(width, this.model.get('default_width'))+'px';
      } else {
        width = "";
      }
      this.$el[0].style.width = width;
      this.$el.children('.box-flyout')[0].style.width = width;
    }
  },

  resizeChatBox: function (ev) {
    var diff;
    if (converse.resizing.direction.indexOf('top') === 0) {
      diff = ev.pageY - this.prev_pageY;
      if (diff) {
        this.height = ((this.height-diff) > (this.model.get('min_height') || 0)) ? (this.height-diff) : this.model.get('min_height');
        this.prev_pageY = ev.pageY;
        this.setChatBoxHeight(this.height);
      }
    }
    if (converse.resizing.direction.indexOf('left') !== -1) {
      diff = this.prev_pageX - ev.pageX;
      if (diff) {
        this.width = ((this.width+diff) > (this.model.get('min_width') || 0)) ? (this.width+diff) : this.model.get('min_width');
        this.prev_pageX = ev.pageX;
        this.setChatBoxWidth(this.width);
      }
    }
  },

  clearMessages: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var result = confirm(__("Are you sure you want to clear the messages from this chat box?"));
    if (result === true) {
      this.$content.empty();
      this.model.messages.reset();
      this.model.messages.browserStorage._clear();
    }
    return this;
  },

  insertEmoticon: function (ev) {
    ev.stopPropagation();
    this.$el.find('.toggle-smiley ul').slideToggle(200);
    var $textbox = this.$el.find('textarea.chat-textarea');
    var value = $textbox.val();
    var $target = $(ev.target);
    $target = $target.is('a') ? $target : $target.children('a');
    if (value && (value[value.length-1] !== ' ')) {
      value = value + ' ';
    }
    $textbox.focus().val(value+$target.data('emoticon')+' ');
  },

  toggleEmoticonMenu: function (ev) {
    ev.stopPropagation();
    this.$el.find('.toggle-smiley ul').slideToggle(200);
  },

  toggleOTRMenu: function (ev) {
    ev.stopPropagation();
    this.$el.find('.toggle-otr ul').slideToggle(200);
  },

  showOTRError: function (msg) {
    if (msg === 'Message cannot be sent at this time.') {
      this.showHelpMessages(
        [__('Your message could not be sent')], 'error');
    } else if (msg === 'Received an unencrypted message.') {
      this.showHelpMessages(
        [__('We received an unencrypted message')], 'error');
    } else if (msg === 'Received an unreadable encrypted message.') {
      this.showHelpMessages(
        [__('We received an unreadable encrypted message')],
        'error');
    } else {
      this.showHelpMessages(['Encryption error occured: '+msg], 'error');
    }
    converse.log("OTR ERROR:"+msg);
  },

  startOTRFromToolbar: function (ev) {
    $(ev.target).parent().parent().slideUp();
    ev.stopPropagation();
    this.model.initiateOTR();
  },

  endOTR: function (ev) {
    if (typeof ev !== "undefined") {
      ev.preventDefault();
      ev.stopPropagation();
    }
    this.model.endOTR();
  },

  authOTR: function (ev) {
    var scheme = $(ev.target).data().scheme;
    var result, question, answer;
    if (scheme === 'fingerprint') {
      result = confirm(__('Here are the fingerprints, please confirm them with %1$s, outside of this chat.\n\nFingerprint for you, %2$s: %3$s\n\nFingerprint for %1$s: %4$s\n\nIf you have confirmed that the fingerprints match, click OK, otherwise click Cancel.', [
          this.model.get('fullname'),
          converse.xmppstatus.get('fullname')||converse.bare_jid,
          this.model.otr.priv.fingerprint(),
          this.model.otr.their_priv_pk.fingerprint()
        ]
      ));
      if (result === true) {
        this.model.save({'otr_status': VERIFIED});
      } else {
        this.model.save({'otr_status': UNVERIFIED});
      }
    } else if (scheme === 'smp') {
      alert(__('You will be prompted to provide a security question and then an answer to that question.\n\nYour contact will then be prompted the same question and if they type the exact same answer (case sensitive), their identity will be verified.'));
      question = prompt(__('What is your security question?'));
      if (question) {
        answer = prompt(__('What is the answer to the security question?'));
        this.model.otr.smpSecret(answer, question);
      }
    } else {
      this.showHelpMessages([__('Invalid authentication scheme provided')], 'error');
    }
  },

  toggleCall: function (ev) {
    ev.stopPropagation();
    converse.emit('callButtonClicked', {
      connection: converse.connection,
      model: this.model
    });
  },

  onChatStatusChanged: function (item) {
    var chat_status = item.get('chat_status'),
      fullname = item.get('fullname');
    fullname = _.isEmpty(fullname)? item.get('jid'): fullname;
    if (this.$el.is(':visible')) {
      if (chat_status === 'offline') {
        this.showStatusNotification(fullname+' '+__('has gone offline'));
      } else if (chat_status === 'away') {
        this.showStatusNotification(fullname+' '+__('has gone away'));
      } else if ((chat_status === 'dnd')) {
        this.showStatusNotification(fullname+' '+__('is busy'));
      } else if (chat_status === 'online') {
        this.$el.find('div.chat-event').remove();
      }
    }
    converse.emit('contactStatusChanged', item.attributes, item.get('chat_status'));
  },

  onStatusChanged: function (item) {
    this.showStatusMessage();
    converse.emit('contactStatusMessageChanged', item.attributes, item.get('status'));
  },

  onOTRStatusChanged: function () {
    this.renderToolbar().informOTRChange();
  },

  onMinimizedChanged: function (item) {
    if (item.get('minimized')) {
      this.hide();
    } else {
      this.maximize();
    }
  },

  showStatusMessage: function (msg) {
    msg = msg || this.model.get('status');
    if (typeof msg === "string") {
      this.$el.find('p.user-custom-message').text(msg).attr('title', msg);
    }
    return this;
  },

  close: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    if (converse.connection.connected) {
      this.model.destroy();
      this.setChatState(INACTIVE);
    } else {
      this.hide();
    }
    converse.emit('chatBoxClosed', this);
    return this;
  },

  maximize: function () {
    var chatboxviews = converse.chatboxviews;
    // Restores a minimized chat box
    this.$el.insertAfter(chatboxviews.get("controlbox").$el).show('fast', function () {
      /* Now that the chat box is visible, we can call trimChats
       * to make space available if need be.
       */
      chatboxviews.trimChats(this);
      converse.refreshWebkit();
      this.setChatState(ACTIVE).focus();
      converse.emit('chatBoxMaximized', this);
    }.bind(this));
  },

  minimize: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    // Minimizes a chat box
    this.setChatState(INACTIVE).model.minimize();
    this.$el.hide('fast', converse.refreshwebkit);
    converse.emit('chatBoxMinimized', this);
  },

  updateVCard: function () {
    if (!this.use_vcards) { return this; }
    var jid = this.model.get('jid'),
      contact = converse.roster.get(jid);
    if ((contact) && (!contact.get('vcard_updated'))) {
      converse.getVCard(
        jid,
        function (iq, jid, fullname, image, image_type, url) {
          this.model.save({
            'fullname' : fullname || jid,
            'url': url,
            'image_type': image_type,
            'image': image
          });
        }.bind(this),
        function () {
          converse.log("ChatBoxView.initialize: An error occured while fetching vcard");
        }
      );
    }
    return this;
  },

  informOTRChange: function () {
    var data = this.model.toJSON();
    var msgs = [];
    if (data.otr_status === UNENCRYPTED) {
      msgs.push(__("Your messages are not encrypted anymore"));
    } else if (data.otr_status === UNVERIFIED) {
      msgs.push(__("Your messages are now encrypted but your contact's identity has not been verified."));
    } else if (data.otr_status === VERIFIED) {
      msgs.push(__("Your contact's identify has been verified."));
    } else if (data.otr_status === FINISHED) {
      msgs.push(__("Your contact has ended encryption on their end, you should do the same."));
    }
    return this.showHelpMessages(msgs, 'info', false);
  },

  renderToolbar: function () {
    if (converse.show_toolbar) {
      var data = this.model.toJSON();
      if (data.otr_status === UNENCRYPTED) {
        data.otr_tooltip = __('Your messages are not encrypted. Click here to enable OTR encryption.');
      } else if (data.otr_status === UNVERIFIED) {
        data.otr_tooltip = __('Your messages are encrypted, but your contact has not been verified.');
      } else if (data.otr_status === VERIFIED) {
        data.otr_tooltip = __('Your messages are encrypted and your contact verified.');
      } else if (data.otr_status === FINISHED) {
        data.otr_tooltip = __('Your contact has closed their end of the private session, you should do the same');
      }
      this.$el.find('.chat-toolbar').html(
        converse.templates.toolbar(
          _.extend(data, {
            FINISHED: FINISHED,
            UNENCRYPTED: UNENCRYPTED,
            UNVERIFIED: UNVERIFIED,
            VERIFIED: VERIFIED,
            allow_otr: converse.allow_otr && !this.is_chatroom,
            label_clear: __('Clear all messages'),
            label_end_encrypted_conversation: __('End encrypted conversation'),
            label_insert_smiley: __('Insert a smiley'),
            label_hide_occupants: __('Hide the list of occupants'),
            label_refresh_encrypted_conversation: __('Refresh encrypted conversation'),
            label_start_call: __('Start a call'),
            label_start_encrypted_conversation: __('Start encrypted conversation'),
            label_verify_with_fingerprints: __('Verify with fingerprints'),
            label_verify_with_smp: __('Verify with SMP'),
            label_whats_this: __("What\'s this?"),
            otr_status_class: OTR_CLASS_MAPPING[data.otr_status],
            otr_translated_status: OTR_TRANSLATED_MAPPING[data.otr_status],
            show_call_button: converse.visible_toolbar_buttons.call,
            show_clear_button: converse.visible_toolbar_buttons.clear,
            show_emoticons: converse.visible_toolbar_buttons.emoticons,
            show_occupants_toggle: this.is_chatroom && converse.visible_toolbar_buttons.toggle_occupants
          })
        )
      );
    }
    return this;
  },

  renderAvatar: function () {
    if (!this.model.get('image')) {
      return;
    }
    var img_src = 'data:'+this.model.get('image_type')+';base64,'+this.model.get('image'),
      canvas = $('<canvas height="32px" width="32px" class="avatar"></canvas>').get(0);

    if (!(canvas.getContext && canvas.getContext('2d'))) {
      return this;
    }
    var ctx = canvas.getContext('2d');
    var img = new Image();   // Create new Image object
    img.onload = function () {
      var ratio = img.width/img.height;
      if (ratio < 1) {
        ctx.drawImage(img, 0,0, 32, 32*(1/ratio));
      } else {
        ctx.drawImage(img, 0,0, 32, 32*ratio);
      }

    };
    img.src = img_src;
    this.$el.find('.chat-title').before(canvas);
    return this;
  },

  focus: function () {
    this.$el.find('.chat-textarea').focus();
    converse.emit('chatBoxFocused', this);
    return this;
  },

  hide: function () {
    if (this.$el.is(':visible') && this.$el.css('opacity') === "1") {
      this.$el.hide();
      converse.refreshWebkit();
    }
    return this;
  },

  show: function (callback) {
    if (this.$el.is(':visible') && this.$el.css('opacity') === "1") {
      return this.focus();
    }
    this.initDragResize().setDimensions();
    this.$el.fadeIn(function () {
      if (typeof callback === "function") {
        callback.apply(this, arguments);
      }
      if (converse.connection.connected) {
        // Without a connection, we haven't yet initialized
        // localstorage
        this.model.save();
      }
      this.setChatState(ACTIVE);
      this.scrollDown().focus();
    }.bind(this));
    return this;
  },

  scrollDownMessageHeight: function ($message) {
    if (this.$content.is(':visible')) {
      this.$content.scrollTop(this.$content.scrollTop() + $message[0].scrollHeight);
    }
    return this;
  },

  scrollDown: function () {
    if (this.$content.is(':visible')) {
      this.$content.scrollTop(this.$content[0].scrollHeight);
    }
    return this;
  }
});

this.ContactsPanel = Backbone.View.extend({
  tagName: 'div',
  className: 'controlbox-pane',
  id: 'users',
  events: {
    'click a.toggle-xmpp-contact-form': 'toggleContactForm',
    'submit form.add-xmpp-contact': 'addContactFromForm',
    'submit form.search-xmpp-contact': 'searchContacts',
    'click a.subscribe-to-user': 'addContactFromList'
  },

  initialize: function (cfg) {
    cfg.$parent.append(this.$el);
    this.$tabs = cfg.$parent.parent().find('#controlbox-tabs');
  },

  render: function () {
    var markup;
    var widgets = converse.templates.contacts_panel({
      label_online: __('Online'),
      label_busy: __('Busy'),
      label_away: __('Away'),
      label_offline: __('Offline'),
      label_logout: __('Log out'),
      allow_logout: converse.allow_logout
    });
    this.$tabs.append(converse.templates.contacts_tab({label_contacts: LABEL_CONTACTS}));
    if (converse.xhr_user_search) {
      markup = converse.templates.search_contact({
        label_contact_name: __('Contact name'),
        label_search: __('Search')
      });
    } else {
      markup = converse.templates.add_contact_form({
        label_contact_username: __('e.g. user@example.com'),
        label_add: __('Add')
      });
    }
    if (converse.allow_contact_requests) {
      widgets += converse.templates.add_contact_dropdown({
        label_click_to_chat: __('Click to add new chat contacts'),
        label_add_contact: __('Add a contact')
      });
    }
    this.$el.html(widgets);
    this.$el.find('.search-xmpp ul').append(markup);
    return this;
  },

  toggleContactForm: function (ev) {
    ev.preventDefault();
    this.$el.find('.search-xmpp').toggle('fast', function () {
      if ($(this).is(':visible')) {
        $(this).find('input.username').focus();
      }
    });
  },

  searchContacts: function (ev) {
    ev.preventDefault();
    $.getJSON(converse.xhr_user_search_url+ "?q=" + $(ev.target).find('input.username').val(), function (data) {
      var $ul= $('.search-xmpp ul');
      $ul.find('li.found-user').remove();
      $ul.find('li.chat-info').remove();
      if (!data.length) {
        $ul.append('<li class="chat-info">'+__('No users found')+'</li>');
      }
      $(data).each(function (idx, obj) {
        $ul.append(
          $('<li class="found-user"></li>')
            .append(
            $('<a class="subscribe-to-user" href="#" title="'+__('Click to add as a chat contact')+'"></a>')
              .attr('data-recipient', Strophe.getNodeFromJid(obj.id)+"@"+Strophe.getDomainFromJid(obj.id))
              .text(obj.fullname)
          )
        );
      });
    });
  },

  addContactFromForm: function (ev) {
    ev.preventDefault();
    var $input = $(ev.target).find('input');
    var jid = $input.val();
    if (! jid) {
      // this is not a valid JID
      $input.addClass('error');
      return;
    }
    converse.roster.addAndSubscribe(jid);
    $('.search-xmpp').hide();
  },

  addContactFromList: function (ev) {
    ev.preventDefault();
    var $target = $(ev.target),
      jid = $target.attr('data-recipient'),
      name = $target.text();
    converse.roster.addAndSubscribe(jid, name);
    $target.parent().remove();
    $('.search-xmpp').hide();
  }
});

this.RoomsPanel = Backbone.View.extend({
  tagName: 'div',
  className: 'controlbox-pane',
  id: 'chatrooms',
  events: {
    'submit form.add-chatroom': 'createChatRoom',
    'click input#show-rooms': 'showRooms',
    'click a.open-room': 'createChatRoom',
    'click a.room-info': 'showRoomInfo',
    'change input[name=server]': 'setDomain',
    'change input[name=nick]': 'setNick'
  },

  initialize: function (cfg) {
    this.$parent = cfg.$parent;
    this.model.on('change:muc_domain', this.onDomainChange, this);
    this.model.on('change:nick', this.onNickChange, this);
  },

  render: function () {
    this.$parent.append(
      this.$el.html(
        converse.templates.room_panel({
          'server_input_type': converse.hide_muc_server && 'hidden' || 'text',
          'server_label_global_attr': converse.hide_muc_server && ' hidden' || '',
          'label_room_name': __('Room name'),
          'label_nickname': __('Nickname'),
          'label_server': __('Server'),
          'label_join': __('Join Room'),
          'label_show_rooms': __('Show rooms')
        })
      ).hide());
    this.$tabs = this.$parent.parent().find('#controlbox-tabs');
    this.$tabs.append(converse.templates.chatrooms_tab({label_rooms: __('Rooms')}));
    return this;
  },

  onDomainChange: function (model) {
    var $server = this.$el.find('input.new-chatroom-server');
    $server.val(model.get('muc_domain'));
    if (converse.auto_list_rooms) {
      this.updateRoomsList();
    }
  },

  onNickChange: function (model) {
    var $nick = this.$el.find('input.new-chatroom-nick');
    $nick.val(model.get('nick'));
  },

  informNoRoomsFound: function () {
    var $available_chatrooms = this.$el.find('#available-chatrooms');
    // # For translators: %1$s is a variable and will be replaced with the XMPP server name
    $available_chatrooms.html('<dt>'+__('No rooms on %1$s',this.model.get('muc_domain'))+'</dt>');
    $('input#show-rooms').show().siblings('span.spinner').remove();
  },

  onRoomsFound: function (iq) {
    /* Handle the IQ stanza returned from the server, containing
     * all its public rooms.
     */
    var name, jid, i, fragment,
      $available_chatrooms = this.$el.find('#available-chatrooms');
    this.rooms = $(iq).find('query').find('item');
    if (this.rooms.length) {
      // # For translators: %1$s is a variable and will be
      // # replaced with the XMPP server name
      $available_chatrooms.html('<dt>'+__('Rooms on %1$s',this.model.get('muc_domain'))+'</dt>');
      fragment = document.createDocumentFragment();
      for (i=0; i<this.rooms.length; i++) {
        name = Strophe.unescapeNode($(this.rooms[i]).attr('name')||$(this.rooms[i]).attr('jid'));
        jid = $(this.rooms[i]).attr('jid');
        fragment.appendChild($(
          converse.templates.room_item({
            'name':name,
            'jid':jid,
            'open_title': __('Click to open this room'),
            'info_title': __('Show more information on this room')
          })
        )[0]);
      }
      $available_chatrooms.append(fragment);
      $('input#show-rooms').show().siblings('span.spinner').remove();
    } else {
      this.informNoRoomsFound();
    }
    return true;
  },

  updateRoomsList: function () {
    /* Send and IQ stanza to the server asking for all rooms
     */
    converse.connection.sendIQ(
      $iq({
        to: this.model.get('muc_domain'),
        from: converse.connection.jid,
        type: "get"
      }).c("query", {xmlns: Strophe.NS.DISCO_ITEMS}),
      this.onRoomsFound.bind(this),
      this.informNoRoomsFound.bind(this)
    );
  },

  showRooms: function () {
    var $available_chatrooms = this.$el.find('#available-chatrooms');
    var $server = this.$el.find('input.new-chatroom-server');
    var server = $server.val();
    if (!server) {
      $server.addClass('error');
      return;
    }
    this.$el.find('input.new-chatroom-name').removeClass('error');
    $server.removeClass('error');
    $available_chatrooms.empty();
    $('input#show-rooms').hide().after('<span class="spinner"/>');
    this.model.save({muc_domain: server});
    this.updateRoomsList();
  },

  showRoomInfo: function (ev) {
    var target = ev.target,
      $dd = $(target).parent('dd'),
      $div = $dd.find('div.room-info');
    if ($div.length) {
      $div.remove();
    } else {
      $dd.find('span.spinner').remove();
      $dd.append('<span class="spinner hor_centered"/>');
      converse.connection.disco.info(
        $(target).attr('data-room-jid'),
        null,
        function (stanza) {
          var $stanza = $(stanza);
          // All MUC features found here: http://xmpp.org/registrar/disco-features.html
          $dd.find('span.spinner').replaceWith(
            converse.templates.room_description({
              'desc': $stanza.find('field[var="muc#roominfo_description"] value').text(),
              'occ': $stanza.find('field[var="muc#roominfo_occupants"] value').text(),
              'hidden': $stanza.find('feature[var="muc_hidden"]').length,
              'membersonly': $stanza.find('feature[var="muc_membersonly"]').length,
              'moderated': $stanza.find('feature[var="muc_moderated"]').length,
              'nonanonymous': $stanza.find('feature[var="muc_nonanonymous"]').length,
              'open': $stanza.find('feature[var="muc_open"]').length,
              'passwordprotected': $stanza.find('feature[var="muc_passwordprotected"]').length,
              'persistent': $stanza.find('feature[var="muc_persistent"]').length,
              'publicroom': $stanza.find('feature[var="muc_public"]').length,
              'semianonymous': $stanza.find('feature[var="muc_semianonymous"]').length,
              'temporary': $stanza.find('feature[var="muc_temporary"]').length,
              'unmoderated': $stanza.find('feature[var="muc_unmoderated"]').length,
              'label_desc': __('Description:'),
              'label_occ': __('Occupants:'),
              'label_features': __('Features:'),
              'label_requires_auth': __('Requires authentication'),
              'label_hidden': __('Hidden'),
              'label_requires_invite': __('Requires an invitation'),
              'label_moderated': __('Moderated'),
              'label_non_anon': __('Non-anonymous'),
              'label_open_room': __('Open room'),
              'label_permanent_room': __('Permanent room'),
              'label_public': __('Public'),
              'label_semi_anon':  __('Semi-anonymous'),
              'label_temp_room':  __('Temporary room'),
              'label_unmoderated': __('Unmoderated')
            }));
        }.bind(this));
    }
  },

  createChatRoom: function (ev) {
    ev.preventDefault();
    var name, $name,
      server, $server,
      jid,
      $nick = this.$el.find('input.new-chatroom-nick'),
      nick = $nick.val(),
      chatroom;

    if (!nick) { $nick.addClass('error'); }
    else { $nick.removeClass('error'); }

    if (ev.type === 'click') {
      name = $(ev.target).text();
      jid = $(ev.target).attr('data-room-jid');
    } else {
      $name = this.$el.find('input.new-chatroom-name');
      $server= this.$el.find('input.new-chatroom-server');
      server = $server.val();
      name = $name.val().trim();
      $name.val(''); // Clear the input
      if (name && server) {
        jid = Strophe.escapeNode(name.toLowerCase()) + '@' + server;
        $name.removeClass('error');
        $server.removeClass('error');
        this.model.save({muc_domain: server});
      } else {
        if (!name) { $name.addClass('error'); }
        if (!server) { $server.addClass('error'); }
        return;
      }
    }
    if (!nick) { return; }
    chatroom = converse.chatboxviews.showChat({
      'id': jid,
      'jid': jid,
      'name': name || Strophe.unescapeNode(Strophe.getNodeFromJid(jid)),
      'nick': nick,
      'chatroom': true,
      'box_id' : b64_sha1(jid)
    });
  },

  setDomain: function (ev) {
    this.model.save({muc_domain: ev.target.value});
  },

  setNick: function (ev) {
    this.model.save({nick: ev.target.value});
  }
});

this.ControlBoxView = converse.ChatBoxView.extend({
  tagName: 'div',
  className: 'chatbox',
  id: 'controlbox',
  events: {
    'click a.close-chatbox-button': 'close',
    'click ul#controlbox-tabs li a': 'switchTab',
    'mousedown .dragresize-top': 'onStartVerticalResize',
    'mousedown .dragresize-left': 'onStartHorizontalResize',
    'mousedown .dragresize-topleft': 'onStartDiagonalResize'
  },

  initialize: function () {
    this.$el.insertAfter(converse.controlboxtoggle.$el);
    $(window).on('resize', _.debounce(this.setDimensions.bind(this), 100));
    this.model.on('change:connected', this.onConnected, this);
    this.model.on('destroy', this.hide, this);
    this.model.on('hide', this.hide, this);
    this.model.on('show', this.show, this);
    this.model.on('change:closed', this.ensureClosedState, this);
    this.render();
    if (this.model.get('connected')) {
      this.initRoster();
    }
    if (!this.model.get('closed')) {
      this.show();
    } else {
      this.hide();
    }
  },

  render: function () {
    if (!converse.connection.connected || !converse.connection.authenticated || converse.connection.disconnecting) {
      // TODO: we might need to take prebinding into consideration here.
      this.renderLoginPanel();
    } else if (!this.contactspanel || !this.contactspanel.$el.is(':visible')) {
      this.renderContactsPanel();
    }
    return this;
  },

  giveFeedback: function (message, klass) {
    var $el = this.$('.conn-feedback');
    $el.addClass('conn-feedback').text(message);
    if (klass) {
      $el.addClass(klass);
    }
  },

  onConnected: function () {
    if (this.model.get('connected')) {
      this.render().initRoster();
      converse.features.off('add', this.featureAdded, this);
      converse.features.on('add', this.featureAdded, this);
      // Features could have been added before the controlbox was
      // initialized. Currently we're only interested in MUC
      var feature = converse.features.findWhere({'var': Strophe.NS.MUC});
      if (feature) {
        this.featureAdded(feature);
      }
    }
  },

  initRoster: function () {
    /* We initialize the roster, which will appear inside the
     * Contacts Panel.
     */
    converse.roster = new converse.RosterContacts();
    converse.roster.browserStorage = new Backbone.BrowserStorage[converse.storage](
      b64_sha1('converse.contacts-'+converse.bare_jid));
    var rostergroups = new converse.RosterGroups();
    rostergroups.browserStorage = new Backbone.BrowserStorage[converse.storage](
      b64_sha1('converse.roster.groups'+converse.bare_jid));
    converse.rosterview = new converse.RosterView({model: rostergroups});
    this.contactspanel.$el.append(converse.rosterview.$el);
    converse.rosterview.render().fetch().update();
    return this;
  },

  renderLoginPanel: function () {
    var $feedback = this.$('.conn-feedback'); // we want to still show any existing feedback.
    this.$el.html(converse.templates.controlbox(this.model.toJSON()));
    var cfg = {'$parent': this.$el.find('.controlbox-panes'), 'model': this};
    if (!this.loginpanel) {
      this.loginpanel = new converse.LoginPanel(cfg);
      if (converse.allow_registration) {
        this.registerpanel = new converse.RegisterPanel(cfg);
      }
    } else {
      this.loginpanel.delegateEvents().initialize(cfg);
      if (converse.allow_registration) {
        this.registerpanel.delegateEvents().initialize(cfg);
      }
    }
    this.loginpanel.render();
    if (converse.allow_registration) {
      this.registerpanel.render().$el.hide();
    }
    this.initDragResize().setDimensions();
    if ($feedback.length && $feedback.text() !== __('Connecting')) {
      this.$('.conn-feedback').replaceWith($feedback);
    }
    return this;
  },

  renderContactsPanel: function () {
    this.$el.html(converse.templates.controlbox(this.model.toJSON()));
    this.contactspanel = new converse.ContactsPanel({'$parent': this.$el.find('.controlbox-panes')});
    this.contactspanel.render();
    converse.xmppstatusview = new converse.XMPPStatusView({'model': converse.xmppstatus});
    converse.xmppstatusview.render();
    if (converse.allow_muc) {
      this.roomspanel = new converse.RoomsPanel({
        '$parent': this.$el.find('.controlbox-panes'),
        'model': new (Backbone.Model.extend({
          id: b64_sha1('converse.roomspanel'+converse.bare_jid), // Required by sessionStorage
          browserStorage: new Backbone.BrowserStorage[converse.storage](
            b64_sha1('converse.roomspanel'+converse.bare_jid))
        }))()
      });
      this.roomspanel.render().model.fetch();
      if (!this.roomspanel.model.get('nick')) {
        this.roomspanel.model.save({nick: Strophe.getNodeFromJid(converse.bare_jid)});
      }
    }
    this.initDragResize().setDimensions();
  },

  close: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    if (converse.connection.connected) {
      this.model.save({'closed': true});
    } else {
      this.model.trigger('hide');
    }
    converse.emit('controlBoxClosed', this);
    return this;
  },

  ensureClosedState: function () {
    if (this.model.get('closed')) {
      this.hide();
    } else {
      this.show();
    }
  },

  hide: function (callback) {
    this.$el.hide('fast', function () {
      converse.refreshWebkit();
      converse.emit('chatBoxClosed', this);
      converse.controlboxtoggle.show(function () {
        if (typeof callback === "function") {
          callback();
        }
      });
    });
    return this;
  },

  show: function () {
    converse.controlboxtoggle.hide(function () {
      this.$el.show('fast', function () {
        if (converse.rosterview) {
          converse.rosterview.update();
        }
        converse.refreshWebkit();
      }.bind(this));
      converse.emit('controlBoxOpened', this);
    }.bind(this));
    return this;
  },

  featureAdded: function (feature) {
    if ((feature.get('var') === Strophe.NS.MUC) && (converse.allow_muc)) {
      this.roomspanel.model.save({muc_domain: feature.get('from')});
      var $server= this.$el.find('input.new-chatroom-server');
      if (! $server.is(':focus')) {
        $server.val(this.roomspanel.model.get('muc_domain'));
      }
    }
  },

  switchTab: function (ev) {
    // TODO: automatically focus the relevant input
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var $tab = $(ev.target),
      $sibling = $tab.parent().siblings('li').children('a'),
      $tab_panel = $($tab.attr('href'));
    $($sibling.attr('href')).hide();
    $sibling.removeClass('current');
    $tab.addClass('current');
    $tab_panel.show();
    return this;
  },

  showHelpMessages: function (msgs) {
    // Override showHelpMessages in ChatBoxView, for now do nothing.
    return;
  }
});

this.ChatRoomOccupant = Backbone.Model;
this.ChatRoomOccupantView = Backbone.View.extend({
  tagName: 'li',
  initialize: function () {
    this.model.on('add', this.render, this);
    this.model.on('change', this.render, this);
    this.model.on('destroy', this.destroy, this);
  },
  render: function () {
    var $new = converse.templates.occupant(
      _.extend(
        this.model.toJSON(), {
          'desc_moderator': __('This user is a moderator'),
          'desc_occupant': __('This user can send messages in this room'),
          'desc_visitor': __('This user can NOT send messages in this room')
        })
    );
    this.$el.replaceWith($new);
    this.setElement($new, true);
    return this;
  },

  destroy: function () {
    this.$el.remove();
  }
});

this.ChatRoomOccupants = Backbone.Collection.extend({
  model: converse.ChatRoomOccupant
});

this.ChatRoomOccupantsView = Backbone.Overview.extend({
  tagName: 'div',
  className: 'occupants',

  initialize: function () {
    this.model.on("add", this.onOccupantAdded, this);
  },

  render: function () {
    this.$el.html(
      converse.templates.chatroom_sidebar({
        'label_invitation': __('Invite...'),
        'label_occupants': __('Occupants')
      })
    );
    return this.initInviteWidget();
  },

  onOccupantAdded: function (item) {
    var view = this.get(item.get('id'));
    if (!view) {
      view = this.add(item.get('id'), new converse.ChatRoomOccupantView({model: item}));
    } else {
      delete view.model; // Remove ref to old model to help garbage collection
      view.model = item;
      view.initialize();
    }
    this.$('.occupant-list').append(view.render().$el);
  },

  parsePresence: function (pres) {
    var id = Strophe.getResourceFromJid(pres.getAttribute("from"));
    var data = {
      id: id,
      nick: id,
      type: pres.getAttribute("type"),
      states: []
    };
    _.each(pres.childNodes, function (child) {
      switch (child.nodeName) {
        case "status":
          data.status = child.textContent || null;
          break;
        case "show":
          data.show = child.textContent || null;
          break;
        case "x":
          if (child.getAttribute("xmlns") === Strophe.NS.MUC_USER) {
            _.each(child.childNodes, function (item) {
              switch (item.nodeName) {
                case "item":
                  data.affiliation = item.getAttribute("affiliation");
                  data.role = item.getAttribute("role");
                  data.jid = item.getAttribute("jid");
                  data.nick = item.getAttribute("nick") || data.nick;
                  break;
                case "status":
                  if (item.getAttribute("code")) {
                    data.states.push(item.getAttribute("code"));
                  }
              }
            });
          }
      }
    });
    return data;
  },

  updateOccupantsOnPresence: function (pres) {
    var occupant;
    var data = this.parsePresence(pres);
    switch (data.type) {
      case 'error':
        return true;
      case 'unavailable':
        occupant = this.model.get(data.id);
        if (occupant) { occupant.destroy(); }
        break;
      default:
        occupant = this.model.get(data.id);
        if (occupant) {
          occupant.save(data);
        } else {
          this.model.create(data);
        }
    }
  },

  initInviteWidget: function () {
    var $el = this.$('input.invited-contact');
    $el.typeahead({
      minLength: 1,
      highlight: true
    }, {
      name: 'contacts-dataset',
      source: function (q, cb) {
        var results = [];
        _.each(converse.roster.filter(contains(['fullname', 'jid'], q)), function (n) {
          results.push({value: n.get('fullname'), jid: n.get('jid')});
        });
        cb(results);
      },
      templates: {
        suggestion: _.template('<p data-jid="{{jid}}">{{value}}</p>')
      }
    });
    $el.on('typeahead:selected', function (ev, suggestion, dname) {
      var reason = prompt(
        __(___('You are about to invite %1$s to the chat room "%2$s". '), suggestion.value, this.model.get('id')) +
        __("You may optionally include a message, explaining the reason for the invitation.")
      );
      if (reason !== null) {
        this.chatroomview.directInvite(suggestion.jid, reason);
      }
      $(ev.target).typeahead('val', '');
    }.bind(this));
    return this;
  }

});

this.ChatRoomView = converse.ChatBoxView.extend({
  length: 300,
  tagName: 'div',
  className: 'chatbox chatroom',
  events: {
    'click .close-chatbox-button': 'close',
    'click .toggle-chatbox-button': 'minimize',
    'click .configure-chatroom-button': 'configureChatRoom',
    'click .toggle-smiley': 'toggleEmoticonMenu',
    'click .toggle-smiley ul li': 'insertEmoticon',
    'click .toggle-clear': 'clearChatRoomMessages',
    'click .toggle-call': 'toggleCall',
    'click .toggle-occupants a': 'toggleOccupants',
    'keypress textarea.chat-textarea': 'keyPressed',
    'mousedown .dragresize-top': 'onStartVerticalResize',
    'mousedown .dragresize-left': 'onStartHorizontalResize',
    'mousedown .dragresize-topleft': 'onStartDiagonalResize'
  },
  is_chatroom: true,

  initialize: function () {
    $(window).on('resize', _.debounce(this.setDimensions.bind(this), 100));
    this.model.messages.on('add', this.onMessageAdded, this);
    this.model.on('change:minimized', function (item) {
      if (item.get('minimized')) {
        this.hide();
      } else {
        this.maximize();
      }
    }, this);
    this.model.on('destroy', function () {
      this.hide().leave();
    }, this);

    this.occupantsview = new converse.ChatRoomOccupantsView({
      model: new converse.ChatRoomOccupants({nick: this.model.get('nick')})
    });
    var id =  b64_sha1('converse.occupants'+converse.bare_jid+this.model.get('id')+this.model.get('nick'));
    this.occupantsview.model.browserStorage = new Backbone.BrowserStorage[converse.storage](id);

    this.occupantsview.chatroomview = this;
    this.render().$el.hide();
    this.occupantsview.model.fetch({add:true});
    this.join(null, {'maxstanzas': converse.muc_history_max_stanzas});
    this.fetchMessages();
    converse.emit('chatRoomOpened', this);

    this.$el.insertAfter(converse.chatboxviews.get("controlbox").$el);
    if (this.model.get('minimized')) {
      this.hide();
    } else {
      this.show();
    }
  },

  render: function () {
    this.$el.attr('id', this.model.get('box_id'))
      .html(converse.templates.chatroom(this.model.toJSON()));
    this.renderChatArea();
    this.$content.on('scroll', _.debounce(this.onScroll.bind(this), 100));
    this.setWidth();
    setTimeout(converse.refreshWebkit, 50);
    return this;
  },

  renderChatArea: function () {
    if (!this.$('.chat-area').length) {
      this.$('.chatroom-body').empty()
        .append(
        converse.templates.chatarea({
          'show_toolbar': converse.show_toolbar,
          'label_message': __('Message')
        }))
        .append(this.occupantsview.render().$el);
      this.renderToolbar();
      this.$content = this.$el.find('.chat-content');
    }
    this.toggleOccupants(null, true);
    return this;
  },

  toggleOccupants: function (ev, preserve_state) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (preserve_state) {
      // Bit of a hack, to make sure that the sidebar's state doesn't change
      this.model.set({hidden_occupants: !this.model.get('hidden_occupants')});
    }
    var $el = this.$('.icon-hide-users');
    if (!this.model.get('hidden_occupants')) {
      this.model.save({hidden_occupants: true});
      $el.removeClass('icon-hide-users').addClass('icon-show-users');
      this.$('.occupants').addClass('hidden');
      this.$('.chat-area').addClass('full');
      this.scrollDown();
    } else {
      this.model.save({hidden_occupants: false});
      $el.removeClass('icon-show-users').addClass('icon-hide-users');
      this.$('.chat-area').removeClass('full');
      this.$('div.occupants').removeClass('hidden');
      this.scrollDown();
    }
  },

  directInvite: function (receiver, reason) {
    var attrs = {
      xmlns: 'jabber:x:conference',
      jid: this.model.get('jid')
    };
    if (reason !== null) { attrs.reason = reason; }
    if (this.model.get('password')) { attrs.password = this.model.get('password'); }
    var invitation = $msg({
      from: converse.connection.jid,
      to: receiver,
      id: converse.connection.getUniqueId()
    }).c('x', attrs);
    converse.connection.send(invitation);
    converse.emit('roomInviteSent', this, receiver, reason);
  },

  onCommandError: function (stanza) {
    this.showStatusNotification(__("Error: could not execute the command"), true);
  },

  sendChatRoomMessage: function (text) {
    var msgid = converse.connection.getUniqueId();
    var msg = $msg({
      to: this.model.get('jid'),
      from: converse.connection.jid,
      type: 'groupchat',
      id: msgid
    }).c("body").t(text).up()
      .c("x", {xmlns: "jabber:x:event"}).c("composing");
    converse.connection.send(msg);

    var fullname = converse.xmppstatus.get('fullname');
    this.model.messages.create({
      fullname: _.isEmpty(fullname)? converse.bare_jid: fullname,
      sender: 'me',
      time: moment().format(),
      message: text,
      msgid: msgid
    });
  },

  setAffiliation: function(room, jid, affiliation, reason, onSuccess, onError) {
    var item = $build("item", {jid: jid, affiliation: affiliation});
    var iq = $iq({to: room, type: "set"}).c("query", {xmlns: Strophe.NS.MUC_ADMIN}).cnode(item.node);
    if (reason !== null) { iq.c("reason", reason); }
    return converse.connection.sendIQ(iq.tree(), onSuccess, onError);
  },

  modifyRole: function(room, nick, role, reason, onSuccess, onError) {
    var item = $build("item", {nick: nick, role: role});
    var iq = $iq({to: room, type: "set"}).c("query", {xmlns: Strophe.NS.MUC_ADMIN}).cnode(item.node);
    if (reason !== null) { iq.c("reason", reason); }
    return converse.connection.sendIQ(iq.tree(), onSuccess, onError);
  },

  member: function(room, jid, reason, handler_cb, error_cb) {
    return this.setAffiliation(room, jid, 'member', reason, handler_cb, error_cb);
  },
  revoke: function(room, jid, reason, handler_cb, error_cb) {
    return this.setAffiliation(room, jid, 'none', reason, handler_cb, error_cb);
  },
  owner: function(room, jid, reason, handler_cb, error_cb) {
    return this.setAffiliation(room, jid, 'owner', reason, handler_cb, error_cb);
  },
  admin: function(room, jid, reason, handler_cb, error_cb) {
    return this.setAffiliation(room, jid, 'admin', reason, handler_cb, error_cb);
  },

  validateRoleChangeCommand: function (command, args) {
    /* Check that a command to change a chat room user's role or
     * affiliation has anough arguments.
     */
    // TODO check if first argument is valid
    if (args.length < 1 || args.length > 2) {
      this.showStatusNotification(
        __("Error: the \""+command+"\" command takes two arguments, the user's nickname and optionally a reason."),
        true
      );
      return false;
    }
    return true;
  },

  onChatRoomMessageSubmitted: function (text) {
    /* Gets called when the user presses enter to send off a
     * message in a chat room.
     *
     * Parameters:
     *    (String) text - The message text.
     */
    var match = text.replace(/^\s*/, "").match(/^\/(.*?)(?: (.*))?$/) || [false, '', ''],
      args = match[2] && match[2].splitOnce(' ') || [];
    switch (match[1]) {
      case 'admin':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.setAffiliation(
          this.model.get('jid'), args[0], 'admin', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'ban':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.setAffiliation(
          this.model.get('jid'), args[0], 'outcast', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'clear':
        this.clearChatRoomMessages();
        break;
      case 'deop':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.modifyRole(
          this.model.get('jid'), args[0], 'occupant', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'help':
        this.showHelpMessages([
          '<strong>/admin</strong>: ' +__("Change user's affiliation to admin"),
          '<strong>/ban</strong>: '   +__('Ban user from room'),
          '<strong>/clear</strong>: ' +__('Remove messages'),
          '<strong>/deop</strong>: '  +__('Change user role to occupant'),
          '<strong>/help</strong>: '  +__('Show this menu'),
          '<strong>/kick</strong>: '  +__('Kick user from room'),
          '<strong>/me</strong>: '    +__('Write in 3rd person'),
          '<strong>/member</strong>: '+__('Grant membership to a user'),
          '<strong>/mute</strong>: '  +__("Remove user's ability to post messages"),
          '<strong>/nick</strong>: '  +__('Change your nickname'),
          '<strong>/op</strong>: '    +__('Grant moderator role to user'),
          '<strong>/owner</strong>: ' +__('Grant ownership of this room'),
          '<strong>/revoke</strong>: '+__("Revoke user's membership"),
          '<strong>/topic</strong>: ' +__('Set room topic'),
          '<strong>/voice</strong>: ' +__('Allow muted user to post messages')
        ]);
        break;
      case 'kick':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.modifyRole(
          this.model.get('jid'), args[0], 'none', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'mute':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.modifyRole(
          this.model.get('jid'), args[0], 'visitor', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'member':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.setAffiliation(
          this.model.get('jid'), args[0], 'member', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'nick':
        converse.connection.send($pres({
          from: converse.connection.jid,
          to: this.getRoomJIDAndNick(match[2]),
          id: converse.connection.getUniqueId()
        }).tree());
        break;
      case 'owner':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.setAffiliation(
          this.model.get('jid'), args[0], 'owner', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'op':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.modifyRole(
          this.model.get('jid'), args[0], 'moderator', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'revoke':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.setAffiliation(
          this.model.get('jid'), args[0], 'none', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      case 'topic':
        converse.connection.send(
          $msg({
            to: this.model.get('jid'),
            from: converse.connection.jid,
            type: "groupchat"
          }).c("subject", {xmlns: "jabber:client"}).t(match[2]).tree()
        );
        break;
      case 'voice':
        if (!this.validateRoleChangeCommand(match[1], args)) { break; }
        this.modifyRole(
          this.model.get('jid'), args[0], 'occupant', args[1],
          undefined, this.onCommandError.bind(this));
        break;
      default:
        this.sendChatRoomMessage(text);
        break;
    }
  },

  handleMUCStanza: function (stanza) {
    var xmlns, xquery, i;
    var from = stanza.getAttribute('from');
    var is_mam = $(stanza).find('[xmlns="'+Strophe.NS.MAM+'"]').length > 0;
    if (!from || (this.model.get('id') !== from.split("/")[0])  || is_mam) {
      return true;
    }
    if (stanza.nodeName === "message") {
      _.compose(this.onChatRoomMessage.bind(this), this.showStatusMessages.bind(this))(stanza);
    } else if (stanza.nodeName === "presence") {
      xquery = stanza.getElementsByTagName("x");
      if (xquery.length > 0) {
        for (i = 0; i < xquery.length; i++) {
          xmlns = xquery[i].getAttribute("xmlns");
          if (xmlns && xmlns.match(Strophe.NS.MUC)) {
            this.onChatRoomPresence(stanza);
            break;
          }
        }
      }
    }
    return true;
  },

  getRoomJIDAndNick: function (nick) {
    nick = nick || this.model.get('nick');
    var room = this.model.get('jid');
    var node = Strophe.getNodeFromJid(room);
    var domain = Strophe.getDomainFromJid(room);
    return node + "@" + domain + (nick !== null ? "/" + nick : "");
  },

  join: function (password, history_attrs, extended_presence) {
    var stanza = $pres({
      from: converse.connection.jid,
      to: this.getRoomJIDAndNick()
    }).c("x", {
      xmlns: Strophe.NS.MUC
    });
    if (typeof history_attrs === "object" && Object.keys(history_attrs).length) {
      stanza = stanza.c("history", history_attrs).up();
    }
    if (password) {
      stanza.cnode(Strophe.xmlElement("password", [], password));
    }
    if (typeof extended_presence !== "undefined" && extended_presence !== null) {
      stanza.up.cnode(extended_presence);
    }
    if (!this.handler) {
      this.handler = converse.connection.addHandler(this.handleMUCStanza.bind(this));
    }
    this.model.set('connection_status', Strophe.Status.CONNECTING);
    return converse.connection.send(stanza);
  },

  leave: function(exit_msg) {
    var presenceid = converse.connection.getUniqueId();
    var presence = $pres({
      type: "unavailable",
      id: presenceid,
      from: converse.connection.jid,
      to: this.getRoomJIDAndNick()
    });
    if (exit_msg !== null) {
      presence.c("status", exit_msg);
    }
    converse.connection.addHandler(
      function () { this.model.set('connection_status', Strophe.Status.DISCONNECTED); }.bind(this),
      null, "presence", null, presenceid);
    converse.connection.send(presence);
  },

  renderConfigurationForm: function (stanza) {
    var $form = this.$el.find('form.chatroom-form'),
      $fieldset = $form.children('fieldset:first'),
      $stanza = $(stanza),
      $fields = $stanza.find('field'),
      title = $stanza.find('title').text(),
      instructions = $stanza.find('instructions').text();
    $fieldset.find('span.spinner').remove();
    $fieldset.append($('<legend>').text(title));
    if (instructions && instructions !== title) {
      $fieldset.append($('<p class="instructions">').text(instructions));
    }
    _.each($fields, function (field) {
      $fieldset.append(utils.xForm2webForm($(field), $stanza));
    });
    $form.append('<fieldset></fieldset>');
    $fieldset = $form.children('fieldset:last');
    $fieldset.append('<input type="submit" class="pure-button button-primary" value="'+__('Save')+'"/>');
    $fieldset.append('<input type="button" class="pure-button button-cancel" value="'+__('Cancel')+'"/>');
    $fieldset.find('input[type=button]').on('click', this.cancelConfiguration.bind(this));
    $form.on('submit', this.saveConfiguration.bind(this));
  },

  sendConfiguration: function(config, onSuccess, onError) {
    // Send an IQ stanza with the room configuration.
    var iq = $iq({to: this.model.get('jid'), type: "set"})
      .c("query", {xmlns: Strophe.NS.MUC_OWNER})
      .c("x", {xmlns: Strophe.NS.XFORM, type: "submit"});
    _.each(config, function (node) { iq.cnode(node).up(); });
    return converse.connection.sendIQ(iq.tree(), onSuccess, onError);
  },

  saveConfiguration: function (ev) {
    ev.preventDefault();
    var that = this;
    var $inputs = $(ev.target).find(':input:not([type=button]):not([type=submit])'),
      count = $inputs.length,
      configArray = [];
    $inputs.each(function () {
      configArray.push(utils.webForm2xForm(this));
      if (!--count) {
        that.sendConfiguration(
          configArray,
          that.onConfigSaved.bind(that),
          that.onErrorConfigSaved.bind(that)
        );
      }
    });
    this.$el.find('div.chatroom-form-container').hide(
      function () {
        $(this).remove();
        that.$el.find('.chat-area').removeClass('hidden');
        that.$el.find('.occupants').removeClass('hidden');
      });
  },

  onConfigSaved: function (stanza) {
    // TODO: provide feedback
  },

  onErrorConfigSaved: function (stanza) {
    this.showStatusNotification(__("An error occurred while trying to save the form."));
  },

  cancelConfiguration: function (ev) {
    ev.preventDefault();
    var that = this;
    this.$el.find('div.chatroom-form-container').hide(
      function () {
        $(this).remove();
        that.$el.find('.chat-area').removeClass('hidden');
        that.$el.find('.occupants').removeClass('hidden');
      });
  },

  configureChatRoom: function (ev) {
    ev.preventDefault();
    if (this.$el.find('div.chatroom-form-container').length) {
      return;
    }
    this.$('.chatroom-body').children().addClass('hidden');
    this.$('.chatroom-body').append(converse.templates.chatroom_form());
    converse.connection.sendIQ(
      $iq({
        to: this.model.get('jid'),
        type: "get"
      }).c("query", {xmlns: Strophe.NS.MUC_OWNER}).tree(),
      this.renderConfigurationForm.bind(this)
    );
  },

  submitPassword: function (ev) {
    ev.preventDefault();
    var password = this.$el.find('.chatroom-form').find('input[type=password]').val();
    this.$el.find('.chatroom-form-container').replaceWith('<span class="spinner centered"/>');
    this.join(password);
  },

  renderPasswordForm: function () {
    this.$('.chatroom-body').children().hide();
    this.$('span.centered.spinner').remove();
    this.$('.chatroom-body').append(
      converse.templates.chatroom_password_form({
        heading: __('This chatroom requires a password'),
        label_password: __('Password: '),
        label_submit: __('Submit')
      }));
    this.$('.chatroom-form').on('submit', this.submitPassword.bind(this));
  },

  showDisconnectMessage: function (msg) {
    this.$('.chat-area').hide();
    this.$('.occupants').hide();
    this.$('span.centered.spinner').remove();
    this.$('.chatroom-body').append($('<p>'+msg+'</p>'));
  },

  /* http://xmpp.org/extensions/xep-0045.html
   * ----------------------------------------
   * 100 message      Entering a room         Inform user that any occupant is allowed to see the user's full JID
   * 101 message (out of band)                Affiliation change  Inform user that his or her affiliation changed while not in the room
   * 102 message      Configuration change    Inform occupants that room now shows unavailable members
   * 103 message      Configuration change    Inform occupants that room now does not show unavailable members
   * 104 message      Configuration change    Inform occupants that a non-privacy-related room configuration change has occurred
   * 110 presence     Any room presence       Inform user that presence refers to one of its own room occupants
   * 170 message or initial presence          Configuration change    Inform occupants that room logging is now enabled
   * 171 message      Configuration change    Inform occupants that room logging is now disabled
   * 172 message      Configuration change    Inform occupants that the room is now non-anonymous
   * 173 message      Configuration change    Inform occupants that the room is now semi-anonymous
   * 174 message      Configuration change    Inform occupants that the room is now fully-anonymous
   * 201 presence     Entering a room         Inform user that a new room has been created
   * 210 presence     Entering a room         Inform user that the service has assigned or modified the occupant's roomnick
   * 301 presence     Removal from room       Inform user that he or she has been banned from the room
   * 303 presence     Exiting a room          Inform all occupants of new room nickname
   * 307 presence     Removal from room       Inform user that he or she has been kicked from the room
   * 321 presence     Removal from room       Inform user that he or she is being removed from the room because of an affiliation change
   * 322 presence     Removal from room       Inform user that he or she is being removed from the room because the room has been changed to members-only and the user is not a member
   * 332 presence     Removal from room       Inform user that he or she is being removed from the room because of a system shutdown
   */
  infoMessages: {
    100: __('This room is not anonymous'),
    102: __('This room now shows unavailable members'),
    103: __('This room does not show unavailable members'),
    104: __('Non-privacy-related room configuration has changed'),
    170: __('Room logging is now enabled'),
    171: __('Room logging is now disabled'),
    172: __('This room is now non-anonymous'),
    173: __('This room is now semi-anonymous'),
    174: __('This room is now fully-anonymous'),
    201: __('A new room has been created')
  },

  disconnectMessages: {
    301: __('You have been banned from this room'),
    307: __('You have been kicked from this room'),
    321: __("You have been removed from this room because of an affiliation change"),
    322: __("You have been removed from this room because the room has changed to members-only and you're not a member"),
    332: __("You have been removed from this room because the MUC (Multi-user chat) service is being shut down.")
  },

  actionInfoMessages: {
    /* XXX: Note the triple underscore function and not double
     * underscore.
     *
     * This is a hack. We can't pass the strings to __ because we
     * don't yet know what the variable to interpolate is.
     *
     * Triple underscore will just return the string again, but we
     * can then at least tell gettext to scan for it so that these
     * strings are picked up by the translation machinery.
     */
    301: ___("<strong>%1$s</strong> has been banned"),
    303: ___("<strong>%1$s</strong>'s nickname has changed"),
    307: ___("<strong>%1$s</strong> has been kicked out"),
    321: ___("<strong>%1$s</strong> has been removed because of an affiliation change"),
    322: ___("<strong>%1$s</strong> has been removed for not being a member")
  },

  newNicknameMessages: {
    210: ___('Your nickname has been automatically changed to: <strong>%1$s</strong>'),
    303: ___('Your nickname has been changed to: <strong>%1$s</strong>')
  },

  showStatusMessages: function (el, is_self) {
    /* Check for status codes and communicate their purpose to the user.
     * Allow user to configure chat room if they are the owner.
     * See: http://xmpp.org/registrar/mucstatus.html
     */
    var $el = $(el),
      disconnect_msgs = [],
      msgs = [],
      reasons = [];
    $el.find('x[xmlns="'+Strophe.NS.MUC_USER+'"]').each(function (idx, x) {
      var $item = $(x).find('item');
      if (Strophe.getBareJidFromJid($item.attr('jid')) === converse.bare_jid && $item.attr('affiliation') === 'owner') {
        this.$el.find('a.configure-chatroom-button').show();
      }
      $(x).find('item reason').each(function (idx, reason) {
        if ($(reason).text()) {
          reasons.push($(reason).text());
        }
      });
      $(x).find('status').each(function (idx, stat) {
        var code = stat.getAttribute('code');
        var from_nick = Strophe.unescapeNode(Strophe.getResourceFromJid($el.attr('from')));
        if (is_self && code === "210") {
          msgs.push(__(this.newNicknameMessages[code], from_nick));
        } else if (is_self && code === "303") {
          msgs.push(__(this.newNicknameMessages[code], $item.attr('nick')));
        } else if (is_self && _.contains(_.keys(this.disconnectMessages), code)) {
          disconnect_msgs.push(this.disconnectMessages[code]);
        } else if (!is_self && _.contains(_.keys(this.actionInfoMessages), code)) {
          msgs.push(__(this.actionInfoMessages[code], from_nick));
        } else if (_.contains(_.keys(this.infoMessages), code)) {
          msgs.push(this.infoMessages[code]);
        } else if (code !== '110') {
          if ($(stat).text()) {
            msgs.push($(stat).text()); // Sometimes the status contains human readable text and not a code.
          }
        }
      }.bind(this));
    }.bind(this));

    if (disconnect_msgs.length > 0) {
      for (i=0; i<disconnect_msgs.length; i++) {
        this.showDisconnectMessage(disconnect_msgs[i]);
      }
      for (i=0; i<reasons.length; i++) {
        this.showDisconnectMessage(__('The reason given is: "'+reasons[i]+'"'), true);
      }
      this.model.set('connection_status', Strophe.Status.DISCONNECTED);
      return;
    }
    for (i=0; i<msgs.length; i++) {
      this.$content.append(converse.templates.info({message: msgs[i]}));
    }
    for (i=0; i<reasons.length; i++) {
      this.showStatusNotification(__('The reason given is: "'+reasons[i]+'"'), true);
    }
    this.scrollDown();
    return el;
  },

  showErrorMessage: function ($error) {
    // We didn't enter the room, so we must remove it from the MUC
    // add-on
    if ($error.attr('type') === 'auth') {
      if ($error.find('not-authorized').length) {
        this.renderPasswordForm();
      } else if ($error.find('registration-required').length) {
        this.showDisconnectMessage(__('You are not on the member list of this room'));
      } else if ($error.find('forbidden').length) {
        this.showDisconnectMessage(__('You have been banned from this room'));
      }
    } else if ($error.attr('type') === 'modify') {
      if ($error.find('jid-malformed').length) {
        this.showDisconnectMessage(__('No nickname was specified'));
      }
    } else if ($error.attr('type') === 'cancel') {
      if ($error.find('not-allowed').length) {
        this.showDisconnectMessage(__('You are not allowed to create new rooms'));
      } else if ($error.find('not-acceptable').length) {
        this.showDisconnectMessage(__("Your nickname doesn't conform to this room's policies"));
      } else if ($error.find('conflict').length) {
        // TODO: give user the option of choosing a different
        // nickname
        this.showDisconnectMessage(__("Your nickname is already taken"));
      } else if ($error.find('item-not-found').length) {
        this.showDisconnectMessage(__("This room does not (yet) exist"));
      } else if ($error.find('service-unavailable').length) {
        this.showDisconnectMessage(__("This room has reached it's maximum number of occupants"));
      }
    }
  },

  onChatRoomPresence: function (pres) {
    var $presence = $(pres), is_self;
    var nick = this.model.get('nick');
    if ($presence.attr('type') === 'error') {
      this.model.set('connection_status', Strophe.Status.DISCONNECTED);
      this.showErrorMessage($presence.find('error'));
    } else {
      is_self = ($presence.find("status[code='110']").length) ||
        ($presence.attr('from') === this.model.get('id')+'/'+Strophe.escapeNode(nick));
      if (this.model.get('connection_status') !== Strophe.Status.CONNECTED) {
        this.model.set('connection_status', Strophe.Status.CONNECTED);
      }
      this.showStatusMessages(pres, is_self);
    }
    this.occupantsview.updateOccupantsOnPresence(pres);
  },

  onChatRoomMessage: function (message) {
    var $message = $(message),
      archive_id = $message.find('result[xmlns="'+Strophe.NS.MAM+'"]').attr('id'),
      delayed = $message.find('delay').length > 0,
      $forwarded = $message.find('forwarded'),
      $delay;

    if ($forwarded.length) {
      $message = $forwarded.children('message');
      $delay = $forwarded.children('delay');
      delayed = $delay.length > 0;
    }
    var body = $message.children('body').text(),
      jid = $message.attr('from'),
      msgid = $message.attr('id'),
      resource = Strophe.getResourceFromJid(jid),
      sender = resource && Strophe.unescapeNode(resource) || '',
      subject = $message.children('subject').text();

    if (msgid && this.model.messages.findWhere({msgid: msgid})) {
      return true; // We already have this message stored.
    }
    if (subject) {
      this.$el.find('.chatroom-topic').text(subject).attr('title', subject);
      // # For translators: the %1$s and %2$s parts will get replaced by the user and topic text respectively
      // # Example: Topic set by JC Brand to: Hello World!
      this.$content.append(
        converse.templates.info({
          'message': __('Topic set by %1$s to: %2$s', sender, subject)
        }));
    }
    if (sender === '') {
      return true;
    }
    this.model.createMessage($message, $delay, archive_id);
    if (!delayed && sender !== this.model.get('nick') && (new RegExp("\\b"+this.model.get('nick')+"\\b")).test(body)) {
      converse.playNotification();
    }
    if (sender !== this.model.get('nick')) {
      // We only emit an event if it's not our own message
      converse.emit('message', message);
    }
    return true;
  }
});

this.ChatBoxes = Backbone.Collection.extend({
  model: converse.ChatBox,
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
      chatbox, resource,
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
    is_me = from_bare_jid === converse.bare_jid;
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

this.ChatBoxViews = Backbone.Overview.extend({

  initialize: function () {
    this.model.on("add", this.onChatBoxAdded, this);
    this.model.on("change:minimized", function (item) {
      if (item.get('minimized') === true) {
        /* When a chat is minimized in trimChats, trimChats needs to be
         * called again (in case the minimized chats toggle is newly shown).
         */
        this.trimChats();
      } else {
        this.trimChats(this.get(item.get('id')));
      }
    }, this);
  },

  _ensureElement: function () {
    /* Override method from backbone.js
     * If the #conversejs element doesn't exist, create it.
     */
    if (!this.el) {
      var $el = $('#conversejs');
      if (!$el.length) {
        $el = $('<div id="conversejs">');
        $('body').append($el);
      }
      $el.html(converse.templates.chats_panel());
      this.setElement($el, false);
    } else {
      this.setElement(_.result(this, 'el'), false);
    }
  },

  onChatBoxAdded: function (item) {
    var view = this.get(item.get('id'));
    if (!view) {
      if (item.get('chatroom')) {
        view = new converse.ChatRoomView({'model': item});
      } else if (item.get('box_id') === 'controlbox') {
        view = new converse.ControlBoxView({model: item});
      } else {
        view = new converse.ChatBoxView({model: item});
      }
      this.add(item.get('id'), view);
    } else {
      delete view.model; // Remove ref to old model to help garbage collection
      view.model = item;
      view.initialize();
    }
    this.trimChats(view);
  },

  trimChats: function (newchat) {
    /* This method is called when a newly created chat box will
     * be shown.
     *
     * It checks whether there is enough space on the page to show
     * another chat box. Otherwise it minimize the oldest chat box
     * to create space.
     */
    if (converse.no_trimming || (this.model.length <= 1)) {
      return;
    }
    var oldest_chat,
      controlbox_width = 0,
      $minimized = converse.minimized_chats.$el,
      minimized_width = _.contains(this.model.pluck('minimized'), true) ? $minimized.outerWidth(true) : 0,
      boxes_width = newchat ? newchat.$el.outerWidth(true) : 0,
      new_id = newchat ? newchat.model.get('id') : null,
      controlbox = this.get('controlbox');

    if (!controlbox || !controlbox.$el.is(':visible')) {
      controlbox_width = converse.controlboxtoggle.$el.outerWidth(true);
    } else {
      controlbox_width = controlbox.$el.outerWidth(true);
    }

    _.each(this.getAll(), function (view) {
      var id = view.model.get('id');
      if ((id !== 'controlbox') && (id !== new_id) && (!view.model.get('minimized')) && view.$el.is(':visible')) {
        boxes_width += view.$el.outerWidth(true);
      }
    });

    if ((minimized_width + boxes_width + controlbox_width) > $('body').outerWidth(true)) {
      oldest_chat = this.getOldestMaximizedChat();
      if (oldest_chat && oldest_chat.get('id') !== new_id) {
        oldest_chat.minimize();
      }
    }
  },

  getOldestMaximizedChat: function () {
    // Get oldest view (which is not controlbox)
    var i = 0;
    var model = this.model.sort().at(i);
    while (model.get('id') === 'controlbox' || model.get('minimized') === true) {
      i++;
      model = this.model.at(i);
      if (!model) {
        return null;
      }
    }
    return model;
  },

  closeAllChatBoxes: function (include_controlbox) {
    // TODO: once Backbone.Overview has been refactored, we should
    // be able to call .each on the views themselves.
    var ids = [];
    this.model.each(function (model) {
      var id = model.get('id');
      if (include_controlbox || id !== 'controlbox') {
        ids.push(id);
      }
    });
    ids.forEach(function(id) {
      var chatbox = this.get(id);
      if (chatbox) { chatbox.close(); }
    }, this);
    return this;
  },

  showChat: function (attrs) {
    /* Find the chat box and show it. If it doesn't exist, create it.
     */
    var chatbox  = this.model.get(attrs.jid);
    if (!chatbox) {
      chatbox = this.model.create(attrs, {
        'error': function (model, response) {
          converse.log(response.responseText);
        }
      });
    }
    if (chatbox.get('minimized')) {
      chatbox.maximize();
    } else {
      chatbox.trigger('show');
    }
    return chatbox;
  }
});

this.MinimizedChatBoxView = Backbone.View.extend({
  tagName: 'div',
  className: 'chat-head',
  events: {
    'click .close-chatbox-button': 'close',
    'click .restore-chat': 'restore'
  },

  initialize: function () {
    this.model.messages.on('add', function (m) {
      if (m.get('message')) {
        this.updateUnreadMessagesCounter();
      }
    }, this);
    this.model.on('change:minimized', this.clearUnreadMessagesCounter, this);
    this.model.on('showReceivedOTRMessage', this.updateUnreadMessagesCounter, this);
    this.model.on('showSentOTRMessage', this.updateUnreadMessagesCounter, this);
  },

  render: function () {
    var data = _.extend(
      this.model.toJSON(),
      { 'tooltip': __('Click to restore this chat') }
    );
    if (this.model.get('chatroom')) {
      data.title = this.model.get('name');
      this.$el.addClass('chat-head-chatroom');
    } else {
      data.title = this.model.get('fullname');
      this.$el.addClass('chat-head-chatbox');
    }
    return this.$el.html(converse.templates.trimmed_chat(data));
  },

  clearUnreadMessagesCounter: function () {
    this.model.set({'num_unread': 0});
    this.render();
  },

  updateUnreadMessagesCounter: function () {
    this.model.set({'num_unread': this.model.get('num_unread') + 1});
    this.render();
  },

  close: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    this.remove();
    this.model.destroy();
    converse.emit('chatBoxClosed', this);
    return this;
  },

  restore: _.debounce(function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    this.model.messages.off('add',null,this);
    this.remove();
    this.model.maximize();
  }, 200, true)
});

this.MinimizedChats = Backbone.Overview.extend({
  el: "#minimized-chats",
  events: {
    "click #toggle-minimized-chats": "toggle"
  },

  initialize: function () {
    this.initToggle();
    this.model.on("add", this.onChanged, this);
    this.model.on("destroy", this.removeChat, this);
    this.model.on("change:minimized", this.onChanged, this);
    this.model.on('change:num_unread', this.updateUnreadMessagesCounter, this);
  },

  tearDown: function () {
    this.model.off("add", this.onChanged);
    this.model.off("destroy", this.removeChat);
    this.model.off("change:minimized", this.onChanged);
    this.model.off('change:num_unread', this.updateUnreadMessagesCounter);
    return this;
  },

  initToggle: function () {
    this.toggleview = new converse.MinimizedChatsToggleView({
      model: new converse.MinimizedChatsToggle()
    });
    var id = b64_sha1('converse.minchatstoggle'+converse.bare_jid);
    this.toggleview.model.id = id; // Appears to be necessary for backbone.browserStorage
    this.toggleview.model.browserStorage = new Backbone.BrowserStorage[converse.storage](id);
    this.toggleview.model.fetch();
  },

  render: function () {
    if (this.keys().length === 0) {
      this.$el.hide('fast');
    } else if (this.keys().length === 1) {
      this.$el.show('fast');
    }
    return this.$el;
  },

  toggle: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    this.toggleview.model.save({'collapsed': !this.toggleview.model.get('collapsed')});
    this.$('.minimized-chats-flyout').toggle();
  },

  onChanged: function (item) {
    if (item.get('id') !== 'controlbox' && item.get('minimized')) {
      this.addChat(item);
    } else if (this.get(item.get('id'))) {
      this.removeChat(item);
    }
  },

  addChat: function (item) {
    var existing = this.get(item.get('id'));
    if (existing && existing.$el.parent().length !== 0) {
      return;
    }
    var view = new converse.MinimizedChatBoxView({model: item});
    this.$('.minimized-chats-flyout').append(view.render());
    this.add(item.get('id'), view);
    this.toggleview.model.set({'num_minimized': this.keys().length});
    this.render();
  },

  removeChat: function (item) {
    this.remove(item.get('id'));
    this.toggleview.model.set({'num_minimized': this.keys().length});
    this.render();
  },

  updateUnreadMessagesCounter: function () {
    var ls = this.model.pluck('num_unread'),
      count = 0, i;
    for (i=0; i<ls.length; i++) { count += ls[i]; }
    this.toggleview.model.set({'num_unread': count});
    this.render();
  }
});

this.MinimizedChatsToggle = Backbone.Model.extend({
  initialize: function () {
    this.set({
      'collapsed': this.get('collapsed') || false,
      'num_minimized': this.get('num_minimized') || 0,
      'num_unread':  this.get('num_unread') || 0
    });
  }
});

this.MinimizedChatsToggleView = Backbone.View.extend({
  el: '#toggle-minimized-chats',

  initialize: function () {
    this.model.on('change:num_minimized', this.render, this);
    this.model.on('change:num_unread', this.render, this);
    this.$flyout = this.$el.siblings('.minimized-chats-flyout');
  },

  render: function () {
    this.$el.html(converse.templates.toggle_chats(
      _.extend(this.model.toJSON(), {
        'Minimized': __('Minimized')
      })
    ));
    if (this.model.get('collapsed')) {
      this.$flyout.hide();
    } else {
      this.$flyout.show();
    }
    return this.$el;
  }
});

this.RosterContact = Backbone.Model.extend({
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

this.RosterContactView = Backbone.View.extend({
  tagName: 'dd',

  events: {
    "click .accept-xmpp-request": "acceptRequest",
    "click .decline-xmpp-request": "declineRequest",
    "click .open-chat": "openChat",
    "click .remove-xmpp-contact": "removeContact"
  },

  initialize: function () {
    this.model.on("change", this.render, this);
    this.model.on("remove", this.remove, this);
    this.model.on("destroy", this.remove, this);
    this.model.on("open", this.openChat, this);
  },

  render: function () {
    if (!this.model.showInRoster()) {
      this.$el.hide();
      return this;
    } else if (this.$el[0].style.display === "none") {
      this.$el.show();
    }
    var item = this.model,
      ask = item.get('ask'),
      chat_status = item.get('chat_status'),
      requesting  = item.get('requesting'),
      subscription = item.get('subscription');

    var classes_to_remove = [
      'current-xmpp-contact',
      'pending-xmpp-contact',
      'requesting-xmpp-contact'
    ].concat(_.keys(STATUSES));

    _.each(classes_to_remove,
      function (cls) {
        if (this.el.className.indexOf(cls) !== -1) {
          this.$el.removeClass(cls);
        }
      }, this);
    this.$el.addClass(chat_status).data('status', chat_status);

    if ((ask === 'subscribe') || (subscription === 'from')) {
      /* ask === 'subscribe'
       *      Means we have asked to subscribe to them.
       *
       * subscription === 'from'
       *      They are subscribed to use, but not vice versa.
       *      We assume that there is a pending subscription
       *      from us to them (otherwise we're in a state not
       *      supported by converse.js).
       *
       *  So in both cases the user is a "pending" contact.
       */
      this.$el.addClass('pending-xmpp-contact');
      this.$el.html(converse.templates.pending_contact(
        _.extend(item.toJSON(), {
          'desc_remove': __('Click to remove this contact'),
          'allow_chat_pending_contacts': converse.allow_chat_pending_contacts
        })
      ));
    } else if (requesting === true) {
      this.$el.addClass('requesting-xmpp-contact');
      this.$el.html(converse.templates.requesting_contact(
        _.extend(item.toJSON(), {
          'desc_accept': __("Click to accept this contact request"),
          'desc_decline': __("Click to decline this contact request"),
          'allow_chat_pending_contacts': converse.allow_chat_pending_contacts
        })
      ));
      converse.controlboxtoggle.showControlBox();
    } else if (subscription === 'both' || subscription === 'to') {
      this.$el.addClass('current-xmpp-contact');
      this.$el.removeClass(_.without(['both', 'to'], subscription)[0]).addClass(subscription);
      this.$el.html(converse.templates.roster_item(
        _.extend(item.toJSON(), {
          'desc_status': STATUSES[chat_status||'offline'],
          'desc_chat': __('Click to chat with this contact'),
          'desc_remove': __('Click to remove this contact'),
          'title_fullname': __('Name'),
          'allow_contact_removal': converse.allow_contact_removal
        })
      ));
    }
    return this;
  },

  openChat: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    return converse.chatboxviews.showChat(this.model.attributes);
  },

  removeContact: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    if (!converse.allow_contact_removal) { return; }
    var result = confirm(__("Are you sure you want to remove this contact?"));
    if (result === true) {
      var iq = $iq({type: 'set'})
        .c('query', {xmlns: Strophe.NS.ROSTER})
        .c('item', {jid: this.model.get('jid'), subscription: "remove"});
      converse.connection.sendIQ(iq,
        function (iq) {
          this.model.destroy();
          this.remove();
        }.bind(this),
        function (err) {
          alert(__("Sorry, there was an error while trying to remove "+name+" as a contact."));
          converse.log(err);
        }
      );
    }
  },

  acceptRequest: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    converse.roster.sendContactAddIQ(
      this.model.get('jid'),
      this.model.get('fullname'),
      [],
      function () { this.model.authorize().subscribe(); }.bind(this)
    );
  },

  declineRequest: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var result = confirm(__("Are you sure you want to decline this contact request?"));
    if (result === true) {
      this.model.unauthorize().destroy();
    }
    return this;
  }
});

this.RosterContacts = Backbone.Collection.extend({
  model: converse.RosterContact,
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

  onRosterPush: function (iq) {
    /* Handle roster updates from the XMPP server.
     * See: https://xmpp.org/rfcs/rfc6121.html#roster-syntax-actions-push
     *
     * Parameters:
     *    (XMLElement) IQ - The IQ stanza received from the XMPP server.
     */
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

this.RosterGroup = Backbone.Model.extend({
  initialize: function (attributes, options) {
    this.set(_.extend({
      description: DESC_GROUP_TOGGLE,
      state: OPENED
    }, attributes));
    // Collection of contacts belonging to this group.
    this.contacts = new converse.RosterContacts();
  }
});

this.RosterGroupView = Backbone.Overview.extend({
  tagName: 'dt',
  className: 'roster-group',
  events: {
    "click a.group-toggle": "toggle"
  },

  initialize: function () {
    this.model.contacts.on("add", this.addContact, this);
    this.model.contacts.on("change:subscription", this.onContactSubscriptionChange, this);
    this.model.contacts.on("change:requesting", this.onContactRequestChange, this);
    this.model.contacts.on("change:chat_status", function (contact) {
      // This might be optimized by instead of first sorting,
      // finding the correct position in positionContact
      this.model.contacts.sort();
      this.positionContact(contact).render();
    }, this);
    this.model.contacts.on("destroy", this.onRemove, this);
    this.model.contacts.on("remove", this.onRemove, this);
    converse.roster.on('change:groups', this.onContactGroupChange, this);
  },

  render: function () {
    this.$el.attr('data-group', this.model.get('name'));
    this.$el.html(
      $(converse.templates.group_header({
        label_group: this.model.get('name'),
        desc_group_toggle: this.model.get('description'),
        toggle_state: this.model.get('state')
      }))
    );
    return this;
  },

  addContact: function (contact) {
    var view = new converse.RosterContactView({model: contact});
    this.add(contact.get('id'), view);
    view = this.positionContact(contact).render();
    if (contact.showInRoster()) {
      if (this.model.get('state') === CLOSED) {
        if (view.$el[0].style.display !== "none") { view.$el.hide(); }
        if (!this.$el.is(':visible')) { this.$el.show(); }
      } else {
        if (this.$el[0].style.display !== "block") { this.show(); }
      }
    }
  },

  positionContact: function (contact) {
    /* Place the contact's DOM element in the correct alphabetical
     * position amongst the other contacts in this group.
     */
    var view = this.get(contact.get('id'));
    var index = this.model.contacts.indexOf(contact);
    view.$el.detach();
    if (index === 0) {
      this.$el.after(view.$el);
    } else if (index === (this.model.contacts.length-1)) {
      this.$el.nextUntil('dt').last().after(view.$el);
    } else {
      this.$el.nextUntil('dt').eq(index).before(view.$el);
    }
    return view;
  },

  show: function () {
    this.$el.show();
    _.each(this.getAll(), function (contactView) {
      if (contactView.model.showInRoster()) {
        contactView.$el.show();
      }
    });
  },

  hide: function () {
    this.$el.nextUntil('dt').addBack().hide();
  },

  filter: function (q) {
    /* Filter the group's contacts based on the query "q".
     * The query is matched against the contact's full name.
     * If all contacts are filtered out (i.e. hidden), then the
     * group must be filtered out as well.
     */
    var matches;
    if (q.length === 0) {
      if (this.model.get('state') === OPENED) {
        this.model.contacts.each(function (item) {
          if (item.showInRoster()) {
            this.get(item.get('id')).$el.show();
          }
        }.bind(this));
      }
      this.showIfNecessary();
    } else {
      q = q.toLowerCase();
      matches = this.model.contacts.filter(contains.not('fullname', q));
      if (matches.length === this.model.contacts.length) { // hide the whole group
        this.hide();
      } else {
        _.each(matches, function (item) {
          this.get(item.get('id')).$el.hide();
        }.bind(this));
        _.each(this.model.contacts.reject(contains.not('fullname', q)), function (item) {
          this.get(item.get('id')).$el.show();
        }.bind(this));
        this.showIfNecessary();
      }
    }
  },

  showIfNecessary: function () {
    if (!this.$el.is(':visible') && this.model.contacts.length > 0) {
      this.$el.show();
    }
  },

  toggle: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var $el = $(ev.target);
    if ($el.hasClass("icon-opened")) {
      this.$el.nextUntil('dt').slideUp();
      this.model.save({state: CLOSED});
      $el.removeClass("icon-opened").addClass("icon-closed");
    } else {
      $el.removeClass("icon-closed").addClass("icon-opened");
      this.model.save({state: OPENED});
      this.filter(
        converse.rosterview.$('.roster-filter').val(),
        converse.rosterview.$('.filter-type').val()
      );
    }
  },

  onContactGroupChange: function (contact) {
    var in_this_group = _.contains(contact.get('groups'), this.model.get('name'));
    var cid = contact.get('id');
    var in_this_overview = !this.get(cid);
    if (in_this_group && !in_this_overview) {
      this.model.contacts.remove(cid);
    } else if (!in_this_group && in_this_overview) {
      this.addContact(contact);
    }
  },

  onContactSubscriptionChange: function (contact) {
    if ((this.model.get('name') === HEADER_PENDING_CONTACTS) && contact.get('subscription') !== 'from') {
      this.model.contacts.remove(contact.get('id'));
    }
  },

  onContactRequestChange: function (contact) {
    if ((this.model.get('name') === HEADER_REQUESTING_CONTACTS) && !contact.get('requesting')) {
      this.model.contacts.remove(contact.get('id'));
    }
  },

  onRemove: function (contact) {
    this.remove(contact.get('id'));
    if (this.model.contacts.length === 0) {
      this.$el.hide();
    }
  }
});

this.RosterGroups = Backbone.Collection.extend({
  model: converse.RosterGroup,
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

this.RosterView = Backbone.Overview.extend({
  tagName: 'div',
  id: 'converse-roster',
  events: {
    "keydown .roster-filter": "liveFilter",
    "click .onX": "clearFilter",
    "mousemove .x": "togglePointer",
    "change .filter-type": "changeFilterType"
  },

  initialize: function () {
    this.roster_handler_ref = this.registerRosterHandler();
    this.rosterx_handler_ref = this.registerRosterXHandler();
    this.presence_ref = this.registerPresenceHandler();
    converse.roster.on("add", this.onContactAdd, this);
    converse.roster.on('change', this.onContactChange, this);
    converse.roster.on("destroy", this.update, this);
    converse.roster.on("remove", this.update, this);
    this.model.on("add", this.onGroupAdd, this);
    this.model.on("reset", this.reset, this);
    this.$roster = $('<dl class="roster-contacts" style="display: none;"></dl>');
  },

  unregisterHandlers: function () {
    converse.connection.deleteHandler(this.roster_handler_ref);
    delete this.roster_handler_ref;
    converse.connection.deleteHandler(this.rosterx_handler_ref);
    delete this.rosterx_handler_ref;
    converse.connection.deleteHandler(this.presence_ref);
    delete this.presence_ref;
  },

  update: _.debounce(function () {
    var $count = $('#online-count');
    $count.text('('+converse.roster.getNumOnlineContacts()+')');
    if (!$count.is(':visible')) {
      $count.show();
    }
    if (this.$roster.parent().length === 0) {
      this.$el.append(this.$roster.show());
    }
    return this.showHideFilter();
  }, converse.animate ? 100 : 0),

  render: function () {
    this.$el.html(converse.templates.roster({
      placeholder: __('Type to filter'),
      label_contacts: LABEL_CONTACTS,
      label_groups: LABEL_GROUPS
    }));
    if (!converse.allow_contact_requests) {
      // XXX: if we ever support live editing of config then
      // we'll need to be able to remove this class on the fly.
      this.$el.addClass('no-contact-requests');
    }
    return this;
  },

  fetch: function () {
    this.model.fetch({
      silent: true, // We use the success handler to handle groups that were added,
                    // we need to first have all groups before positionFetchedGroups
                    // will work properly.
      success: function (collection, resp, options) {
        if (collection.length !== 0) {
          this.positionFetchedGroups(collection, resp, options);
        }
        converse.roster.fetch({
          add: true,
          success: function (collection) {
            if (collection.length > 0) {
              converse.initial_presence_sent = 1;
            } else {
              // We don't have any roster contacts stored
              // in sessionStorage, so lets fetch the
              // roster from the XMPP server.
              converse.roster.fetchFromServer();
            }
          }
        });
      }.bind(this)
    });
    return this;
  },

  changeFilterType: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    this.clearFilter();
    this.filter(
      this.$('.roster-filter').val(),
      ev.target.value
    );
  },

  tog: function (v) {
    return v?'addClass':'removeClass';
  },

  togglePointer: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var el = ev.target;
    $(el)[this.tog(el.offsetWidth-18 < ev.clientX-el.getBoundingClientRect().left)]('onX');
  },

  filter: function (query, type) {
    query = query.toLowerCase();
    if (type === 'groups') {
      _.each(this.getAll(), function (view, idx) {
        if (view.model.get('name').toLowerCase().indexOf(query.toLowerCase()) === -1) {
          view.hide();
        } else if (view.model.contacts.length > 0) {
          view.show();
        }
      });
    } else {
      _.each(this.getAll(), function (view) {
        view.filter(query, type);
      });
    }
  },

  liveFilter: _.debounce(function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var $filter = this.$('.roster-filter');
    var q = $filter.val();
    var t = this.$('.filter-type').val();
    $filter[this.tog(q)]('x');
    this.filter(q, t);
  }, 300),

  clearFilter: function (ev) {
    if (ev && ev.preventDefault) {
      ev.preventDefault();
      $(ev.target).removeClass('x onX').val('');
    }
    this.filter('');
  },

  showHideFilter: function () {
    if (!this.$el.is(':visible')) {
      return;
    }
    var $filter = this.$('.roster-filter');
    var $type  = this.$('.filter-type');
    var visible = $filter.is(':visible');
    if (visible && $filter.val().length > 0) {
      // Don't hide if user is currently filtering.
      return;
    }
    if (this.$roster.hasScrollBar()) {
      if (!visible) {
        $filter.show();
        $type.show();
      }
    } else {
      $filter.hide();
      $type.hide();
    }
    return this;
  },

  reset: function () {
    converse.roster.reset();
    this.removeAll();
    this.$roster = $('<dl class="roster-contacts" style="display: none;"></dl>');
    this.render().update();
    return this;
  },

  registerRosterHandler: function () {
    converse.connection.addHandler(
      converse.roster.onRosterPush.bind(converse.roster),
      Strophe.NS.ROSTER, 'iq', "set"
    );
  },

  registerRosterXHandler: function () {
    var t = 0;
    converse.connection.addHandler(
      function (msg) {
        window.setTimeout(
          function () {
            converse.connection.flush();
            converse.roster.subscribeToSuggestedItems.bind(converse.roster)(msg);
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
        converse.roster.presenceHandler(presence);
        return true;
      }.bind(this), null, 'presence', null);
  },

  onGroupAdd: function (group) {
    var view = new converse.RosterGroupView({model: group});
    this.add(group.get('name'), view.render());
    this.positionGroup(view);
  },

  onContactAdd: function (contact) {
    this.addRosterContact(contact).update();
    if (!contact.get('vcard_updated')) {
      // This will update the vcard, which triggers a change
      // request which will rerender the roster contact.
      converse.getVCard(contact.get('jid'));
    }
  },

  onContactChange: function (contact) {
    this.updateChatBox(contact).update();
    if (_.has(contact.changed, 'subscription')) {
      if (contact.changed.subscription === 'from') {
        this.addContactToGroup(contact, HEADER_PENDING_CONTACTS);
      } else if (_.contains(['both', 'to'], contact.get('subscription'))) {
        this.addExistingContact(contact);
      }
    }
    if (_.has(contact.changed, 'ask') && contact.changed.ask === 'subscribe') {
      this.addContactToGroup(contact, HEADER_PENDING_CONTACTS);
    }
    if (_.has(contact.changed, 'subscription') && contact.changed.requesting === 'true') {
      this.addContactToGroup(contact, HEADER_REQUESTING_CONTACTS);
    }
    this.liveFilter();
  },

  updateChatBox: function (contact) {
    var chatbox = converse.chatboxes.get(contact.get('jid')),
      changes = {};
    if (!chatbox) {
      return this;
    }
    if (_.has(contact.changed, 'chat_status')) {
      changes.chat_status = contact.get('chat_status');
    }
    if (_.has(contact.changed, 'status')) {
      changes.status = contact.get('status');
    }
    chatbox.save(changes);
    return this;
  },

  positionFetchedGroups: function (model, resp, options) {
    /* Instead of throwing an add event for each group
     * fetched, we wait until they're all fetched and then
     * we position them.
     * Works around the problem of positionGroup not
     * working when all groups besides the one being
     * positioned aren't already in inserted into the
     * roster DOM element.
     */
    model.sort();
    model.each(function (group, idx) {
      var view = this.get(group.get('name'));
      if (!view) {
        view = new converse.RosterGroupView({model: group});
        this.add(group.get('name'), view.render());
      }
      if (idx === 0) {
        this.$roster.append(view.$el);
      } else {
        this.appendGroup(view);
      }
    }.bind(this));
  },

  positionGroup: function (view) {
    /* Place the group's DOM element in the correct alphabetical
     * position amongst the other groups in the roster.
     */
    var $groups = this.$roster.find('.roster-group'),
      index = $groups.length ? this.model.indexOf(view.model) : 0;
    if (index === 0) {
      this.$roster.prepend(view.$el);
    } else if (index === (this.model.length-1)) {
      this.appendGroup(view);
    } else {
      $($groups.eq(index)).before(view.$el);
    }
    return this;
  },

  appendGroup: function (view) {
    /* Add the group at the bottom of the roster
     */
    var $last = this.$roster.find('.roster-group').last();
    var $siblings = $last.siblings('dd');
    if ($siblings.length > 0) {
      $siblings.last().after(view.$el);
    } else {
      $last.after(view.$el);
    }
    return this;
  },

  getGroup: function (name) {
    /* Returns the group as specified by name.
     * Creates the group if it doesn't exist.
     */
    var view =  this.get(name);
    if (view) {
      return view.model;
    }
    return this.model.create({name: name, id: b64_sha1(name)});
  },

  addContactToGroup: function (contact, name) {
    this.getGroup(name).contacts.add(contact);
  },

  addExistingContact: function (contact) {
    var groups;
    if (converse.roster_groups) {
      groups = contact.get('groups');
      if (groups.length === 0) {
        groups = [HEADER_UNGROUPED];
      }
    } else {
      groups = [HEADER_CURRENT_CONTACTS];
    }
    _.each(groups, _.bind(this.addContactToGroup, this, contact));
  },

  addRosterContact: function (contact) {
    if (contact.get('subscription') === 'both' || contact.get('subscription') === 'to') {
      this.addExistingContact(contact);
    } else {
      if ((contact.get('ask') === 'subscribe') || (contact.get('subscription') === 'from')) {
        this.addContactToGroup(contact, HEADER_PENDING_CONTACTS);
      } else if (contact.get('requesting') === true) {
        this.addContactToGroup(contact, HEADER_REQUESTING_CONTACTS);
      }
    }
    return this;
  }
});

this.XMPPStatus = Backbone.Model.extend({
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

this.XMPPStatusView = Backbone.View.extend({
  el: "span#xmpp-status-holder",

  events: {
    "click a.choose-xmpp-status": "toggleOptions",
    "click #fancy-xmpp-status-select a.change-xmpp-status-message": "renderStatusChangeForm",
    "submit #set-custom-xmpp-status": "setStatusMessage",
    "click .dropdown dd ul li a": "setStatus"
  },

  initialize: function () {
    this.model.on("change:status", this.updateStatusUI, this);
    this.model.on("change:status_message", this.updateStatusUI, this);
    this.model.on("update-status-ui", this.updateStatusUI, this);
  },

  render: function () {
    // Replace the default dropdown with something nicer
    var $select = this.$el.find('select#select-xmpp-status'),
      chat_status = this.model.get('status') || 'offline',
      options = $('option', $select),
      $options_target,
      options_list = [];
    this.$el.html(converse.templates.choose_status());
    this.$el.find('#fancy-xmpp-status-select')
      .html(converse.templates.chat_status({
        'status_message': this.model.get('status_message') || __("I am %1$s", this.getPrettyStatus(chat_status)),
        'chat_status': chat_status,
        'desc_custom_status': __('Click here to write a custom status message'),
        'desc_change_status': __('Click to change your chat status')
      }));
    // iterate through all the <option> elements and add option values
    options.each(function () {
      options_list.push(converse.templates.status_option({
        'value': $(this).val(),
        'text': this.text
      }));
    });
    $options_target = this.$el.find("#target dd ul").hide();
    $options_target.append(options_list.join(''));
    $select.remove();
    return this;
  },

  toggleOptions: function (ev) {
    ev.preventDefault();
    $(ev.target).parent().parent().siblings('dd').find('ul').toggle('fast');
  },

  renderStatusChangeForm: function (ev) {
    ev.preventDefault();
    var status_message = this.model.get('status') || 'offline';
    var input = converse.templates.change_status_message({
      'status_message': status_message,
      'label_custom_status': __('Custom status'),
      'label_save': __('Save')
    });
    var $xmppstatus = this.$el.find('.xmpp-status');
    $xmppstatus.parent().addClass('no-border');
    $xmppstatus.replaceWith(input);
    this.$el.find('.custom-xmpp-status').focus().focus();
  },

  setStatusMessage: function (ev) {
    ev.preventDefault();
    this.model.setStatusMessage($(ev.target).find('input').val());
  },

  setStatus: function (ev) {
    ev.preventDefault();
    var $el = $(ev.target),
      value = $el.attr('data-value');
    if (value === 'logout') {
      this.$el.find(".dropdown dd ul").hide();
      converse.logOut();
    } else {
      this.model.setStatus(value);
      this.$el.find(".dropdown dd ul").hide();
    }
  },

  getPrettyStatus: function (stat) {
    if (stat === 'chat') {
      return __('online');
    } else if (stat === 'dnd') {
      return __('busy');
    } else if (stat === 'xa') {
      return __('away for long');
    } else if (stat === 'away') {
      return __('away');
    } else if (stat === 'offline') {
      return __('offline');
    } else {
      return __(stat) || __('online');
    }
  },

  updateStatusUI: function (model) {
    var stat = model.get('status');
    // # For translators: the %1$s part gets replaced with the status
    // # Example, I am online
    var status_message = model.get('status_message') || __("I am %1$s", this.getPrettyStatus(stat));
    this.$el.find('#fancy-xmpp-status-select').removeClass('no-border').html(
      converse.templates.chat_status({
        'chat_status': stat,
        'status_message': status_message,
        'desc_custom_status': __('Click here to write a custom status message'),
        'desc_change_status': __('Click to change your chat status')
      }));
  }
});

this.Session = Backbone.Model; // General session settings to be saved to sessionStorage.
this.Feature = Backbone.Model;
this.Features = Backbone.Collection.extend({
  /* Service Discovery
   * -----------------
   * This collection stores Feature Models, representing features
   * provided by available XMPP entities (e.g. servers)
   * See XEP-0030 for more details: http://xmpp.org/extensions/xep-0030.html
   * All features are shown here: http://xmpp.org/registrar/disco-features.html
   */
  model: converse.Feature,
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
    if (feature.get('var') === Strophe.NS.MAM && prefs['default'] !== converse.message_archiving) {
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

this.RegisterPanel = Backbone.View.extend({
  tagName: 'div',
  id: "register",
  className: 'controlbox-pane',
  events: {
    'submit form#converse-register': 'onProviderChosen'
  },

  initialize: function (cfg) {
    this.reset();
    this.$parent = cfg.$parent;
    this.$tabs = cfg.$parent.parent().find('#controlbox-tabs');
    this.registerHooks();
  },

  render: function () {
    this.$parent.append(this.$el.html(
      converse.templates.register_panel({
        'label_domain': __("Your XMPP provider's domain name:"),
        'label_register': __('Fetch registration form'),
        'help_providers': __('Tip: A list of public XMPP providers is available'),
        'help_providers_link': __('here'),
        'href_providers': converse.providers_link,
        'domain_placeholder': converse.domain_placeholder
      })
    ));
    this.$tabs.append(converse.templates.register_tab({label_register: __('Register')}));
    return this;
  },

  registerHooks: function () {
    /* Hook into Strophe's _connect_cb, so that we can send an IQ
     * requesting the registration fields.
     */
    var conn = converse.connection;
    var connect_cb = conn._connect_cb.bind(conn);
    conn._connect_cb = function (req, callback, raw) {
      if (!this._registering) {
        connect_cb(req, callback, raw);
      } else {
        if (this.getRegistrationFields(req, callback, raw)) {
          this._registering = false;
        }
      }
    }.bind(this);
  },

  getRegistrationFields: function (req, _callback, raw) {
    /*  Send an IQ stanza to the XMPP server asking for the
     *  registration fields.
     *  Parameters:
     *    (Strophe.Request) req - The current request
     *    (Function) callback
     */
    converse.log("sendQueryStanza was called");
    var conn = converse.connection;
    conn.connected = true;

    var body = conn._proto._reqToData(req);
    if (!body) { return; }
    if (conn._proto._connect_cb(body) === Strophe.Status.CONNFAIL) {
      return false;
    }
    var register = body.getElementsByTagName("register");
    var mechanisms = body.getElementsByTagName("mechanism");
    if (register.length === 0 && mechanisms.length === 0) {
      conn._proto._no_auth_received(_callback);
      return false;
    }
    if (register.length === 0) {
      conn._changeConnectStatus(
        Strophe.Status.REGIFAIL,
        __('Sorry, the given provider does not support in band account registration. Please try with a different provider.')
      );
      return true;
    }
    // Send an IQ stanza to get all required data fields
    conn._addSysHandler(this.onRegistrationFields.bind(this), null, "iq", null, null);
    conn.send($iq({type: "get"}).c("query", {xmlns: Strophe.NS.REGISTER}).tree());
    return true;
  },

  onRegistrationFields: function (stanza) {
    /*  Handler for Registration Fields Request.
     *
     *  Parameters:
     *    (XMLElement) elem - The query stanza.
     */
    if (stanza.getElementsByTagName("query").length !== 1) {
      converse.connection._changeConnectStatus(Strophe.Status.REGIFAIL, "unknown");
      return false;
    }
    this.setFields(stanza);
    this.renderRegistrationForm(stanza);
    return false;
  },

  reset: function (settings) {
    var defaults = {
      fields: {},
      urls: [],
      title: "",
      instructions: "",
      registered: false,
      _registering: false,
      domain: null,
      form_type: null
    };
    _.extend(this, defaults);
    if (settings) {
      _.extend(this, _.pick(settings, Object.keys(defaults)));
    }
  },

  onProviderChosen: function (ev) {
    /* Callback method that gets called when the user has chosen an
     * XMPP provider.
     *
     * Parameters:
     *      (Submit Event) ev - Form submission event.
     */
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var $form = $(ev.target),
      $domain_input = $form.find('input[name=domain]'),
      domain = $domain_input.val();
    if (!domain) {
      $domain_input.addClass('error');
      return;
    }
    $form.find('input[type=submit]').hide()
      .after(converse.templates.registration_request({
        cancel: __('Cancel'),
        info_message: __('Requesting a registration form from the XMPP server')
      }));
    $form.find('button.cancel').on('click', this.cancelRegistration.bind(this));
    this.reset({
      domain: Strophe.getDomainFromJid(domain),
      _registering: true
    });
    converse.connection.connect(this.domain, "", this.onRegistering.bind(this));
    return false;
  },

  giveFeedback: function (message, klass) {
    this.$('.reg-feedback').attr('class', 'reg-feedback').text(message);
    if (klass) {
      $('.reg-feedback').addClass(klass);
    }
  },

  onRegistering: function (status, error) {
    var that;
    converse.log('onRegistering');
    if (_.contains([
        Strophe.Status.DISCONNECTED,
        Strophe.Status.CONNFAIL,
        Strophe.Status.REGIFAIL,
        Strophe.Status.NOTACCEPTABLE,
        Strophe.Status.CONFLICT
      ], status)) {

      converse.log('Problem during registration: Strophe.Status is: '+status);
      this.cancelRegistration();
      if (error) {
        this.giveFeedback(error, 'error');
      } else {
        this.giveFeedback(__(
          'Something went wrong while establishing a connection with "%1$s". Are you sure it exists?',
          this.domain
        ), 'error');
      }
    } else if (status === Strophe.Status.REGISTERED) {
      converse.log("Registered successfully.");
      converse.connection.reset();
      that = this;
      this.$('form').hide(function () {
        $(this).replaceWith('<span class="spinner centered"/>');
        if (that.fields.password && that.fields.username) {
          // automatically log the user in
          converse.connection.connect(
            that.fields.username.toLowerCase()+'@'+that.domain.toLowerCase(),
            that.fields.password,
            converse.onConnectStatusChanged
          );
          converse.chatboxviews.get('controlbox')
            .switchTab({target: that.$tabs.find('.current')})
            .giveFeedback(__('Now logging you in'));
        } else {
          converse.chatboxviews.get('controlbox')
            .renderLoginPanel()
            .giveFeedback(__('Registered successfully'));
        }
        that.reset();
      });
    }
  },

  renderRegistrationForm: function (stanza) {
    /* Renders the registration form based on the XForm fields
     * received from the XMPP server.
     *
     * Parameters:
     *      (XMLElement) stanza - The IQ stanza received from the XMPP server.
     */
    var $form= this.$('form'),
      $stanza = $(stanza),
      $fields, $input;
    $form.empty().append(converse.templates.registration_form({
      'domain': this.domain,
      'title': this.title,
      'instructions': this.instructions
    }));
    if (this.form_type === 'xform') {
      $fields = $stanza.find('field');
      _.each($fields, function (field) {
        $form.append(utils.xForm2webForm.bind(this, $(field), $stanza));
      }.bind(this));
    } else {
      // Show fields
      _.each(Object.keys(this.fields), function (key) {
        if (key === "username") {
          $input = templates.form_username({
            domain: ' @'+this.domain,
            name: key,
            type: "text",
            label: key,
            value: '',
            required: 1
          });
        } else {
          $form.append('<label>'+key+'</label>');
          $input = $('<input placeholder="'+key+'" name="'+key+'"></input>');
          if (key === 'password' || key === 'email') {
            $input.attr('type', key);
          }
        }
        $form.append($input);
      }.bind(this));
      // Show urls
      _.each(this.urls, function (url) {
        $form.append($('<a target="blank"></a>').attr('href', url).text(url));
      }.bind(this));
    }
    if (this.fields) {
      $form.append('<input type="submit" class="pure-button button-primary" value="'+__('Register')+'"/>');
      $form.on('submit', this.submitRegistrationForm.bind(this));
      $form.append('<input type="button" class="pure-button button-cancel" value="'+__('Cancel')+'"/>');
      $form.find('input[type=button]').on('click', this.cancelRegistration.bind(this));
    } else {
      $form.append('<input type="button" class="submit" value="'+__('Return')+'"/>');
      $form.find('input[type=button]').on('click', this.cancelRegistration.bind(this));
    }
  },

  reportErrors: function (stanza) {
    /* Report back to the user any error messages received from the
     * XMPP server after attempted registration.
     *
     * Parameters:
     *      (XMLElement) stanza - The IQ stanza received from the
     *      XMPP server.
     */
    var $form= this.$('form'), flash;
    var $errmsgs = $(stanza).find('error text');
    var $flash = $form.find('.form-errors');
    if (!$flash.length) {
      flash = '<legend class="form-errors"></legend>';
      if ($form.find('p.instructions').length) {
        $form.find('p.instructions').append(flash);
      } else {
        $form.prepend(flash);
      }
      $flash = $form.find('.form-errors');
    } else {
      $flash.empty();
    }
    $errmsgs.each(function (idx, txt) {
      $flash.append($('<p>').text($(txt).text()));
    });
    if (!$errmsgs.length) {
      $flash.append($('<p>').text(
        __('The provider rejected your registration attempt. '+
          'Please check the values you entered for correctness.')));
    }
    $flash.show();
  },

  cancelRegistration: function (ev) {
    /* Handler, when the user cancels the registration form.
     */
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    converse.connection.reset();
    this.render();
  },

  submitRegistrationForm : function (ev) {
    /* Handler, when the user submits the registration form.
     * Provides form error feedback or starts the registration
     * process.
     *
     * Parameters:
     *      (Event) ev - the submit event.
     */
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var $empty_inputs = this.$('input.required:emptyVal');
    if ($empty_inputs.length) {
      $empty_inputs.addClass('error');
      return;
    }
    var $inputs = $(ev.target).find(':input:not([type=button]):not([type=submit])'),
      iq = $iq({type: "set"}).c("query", {xmlns:Strophe.NS.REGISTER});

    if (this.form_type === 'xform') {
      iq.c("x", {xmlns: Strophe.NS.XFORM, type: 'submit'});
      $inputs.each(function () {
        iq.cnode(utils.webForm2xForm(this)).up();
      });
    } else {
      $inputs.each(function () {
        var $input = $(this);
        iq.c($input.attr('name'), {}, $input.val());
      });
    }
    converse.connection._addSysHandler(this._onRegisterIQ.bind(this), null, "iq", null, null);
    converse.connection.send(iq);
    this.setFields(iq.tree());
  },

  setFields: function (stanza) {
    /* Stores the values that will be sent to the XMPP server
     * during attempted registration.
     *
     * Parameters:
     *      (XMLElement) stanza - the IQ stanza that will be sent to the XMPP server.
     */
    var $query = $(stanza).find('query'), $xform;
    if ($query.length > 0) {
      $xform = $query.find('x[xmlns="'+Strophe.NS.XFORM+'"]');
      if ($xform.length > 0) {
        this._setFieldsFromXForm($xform);
      } else {
        this._setFieldsFromLegacy($query);
      }
    }
  },

  _setFieldsFromLegacy: function ($query) {
    $query.children().each(function (idx, field) {
      var $field = $(field);
      if (field.tagName.toLowerCase() === 'instructions') {
        this.instructions = Strophe.getText(field);
        return;
      } else if (field.tagName.toLowerCase() === 'x') {
        if ($field.attr('xmlns') === 'jabber:x:oob') {
          $field.find('url').each(function (idx, url) {
            this.urls.push($(url).text());
          }.bind(this));
        }
        return;
      }
      this.fields[field.tagName.toLowerCase()] = Strophe.getText(field);
    }.bind(this));
    this.form_type = 'legacy';
  },

  _setFieldsFromXForm: function ($xform) {
    this.title = $xform.find('title').text();
    this.instructions = $xform.find('instructions').text();
    $xform.find('field').each(function (idx, field) {
      var _var = field.getAttribute('var');
      if (_var) {
        this.fields[_var.toLowerCase()] = $(field).children('value').text();
      } else {
        // TODO: other option seems to be type="fixed"
        converse.log("WARNING: Found field we couldn't parse");
      }
    }.bind(this));
    this.form_type = 'xform';
  },

  _onRegisterIQ: function (stanza) {
    /* Callback method that gets called when a return IQ stanza
     * is received from the XMPP server, after attempting to
     * register a new user.
     *
     * Parameters:
     *      (XMLElement) stanza - The IQ stanza.
     */
    var error = null,
      query = stanza.getElementsByTagName("query");
    if (query.length > 0) {
      query = query[0];
    }
    if (stanza.getAttribute("type") === "error") {
      converse.log("Registration failed.");
      error = stanza.getElementsByTagName("error");
      if (error.length !== 1) {
        converse.connection._changeConnectStatus(Strophe.Status.REGIFAIL, "unknown");
        return false;
      }
      error = error[0].firstChild.tagName.toLowerCase();
      if (error === 'conflict') {
        converse.connection._changeConnectStatus(Strophe.Status.CONFLICT, error);
      } else if (error === 'not-acceptable') {
        converse.connection._changeConnectStatus(Strophe.Status.NOTACCEPTABLE, error);
      } else {
        converse.connection._changeConnectStatus(Strophe.Status.REGIFAIL, error);
      }
      this.reportErrors(stanza);
    } else {
      converse.connection._changeConnectStatus(Strophe.Status.REGISTERED, null);
    }
    return false;
  },

  remove: function () {
    this.$tabs.empty();
    this.$el.parent().empty();
  }
});

this.LoginPanel = Backbone.View.extend({
  tagName: 'div',
  id: "login-dialog",
  className: 'controlbox-pane',
  events: {
    'submit form#converse-login': 'authenticate'
  },

  initialize: function (cfg) {
    cfg.$parent.html(this.$el.html(
      converse.templates.login_panel({
        'LOGIN': LOGIN,
        'ANONYMOUS': ANONYMOUS,
        'PREBIND': PREBIND,
        'auto_login': converse.auto_login,
        'authentication': converse.authentication,
        'label_username': __('XMPP Username:'),
        'label_password': __('Password:'),
        'label_anon_login': __('Click here to log in anonymously'),
        'label_login': __('Log In'),
        'placeholder_username': __('user@server'),
        'placeholder_password': __('password')
      })
    ));
    this.$tabs = cfg.$parent.parent().find('#controlbox-tabs');
  },

  render: function () {
    this.$tabs.append(converse.templates.login_tab({label_sign_in: __('Sign in')}));
    this.$el.find('input#jid').focus();
    if (!this.$el.is(':visible')) {
      this.$el.show();
    }
    return this;
  },

  authenticate: function (ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    var $form = $(ev.target);
    if (converse.authentication === ANONYMOUS) {
      this.connect($form, converse.jid, null);
      return;
    }
    var $jid_input = $form.find('input[name=jid]'),
      jid = $jid_input.val(),
      $pw_input = $form.find('input[name=password]'),
      password = $pw_input.val(),
      errors = false;

    if (! jid) {
      errors = true;
      $jid_input.addClass('error');
    }
    if (! password)  {
      errors = true;
      $pw_input.addClass('error');
    }
    if (errors) { return; }
    this.connect($form, jid, password);
    return false;
  },

  connect: function ($form, jid, password) {
    var resource;
    if ($form) {
      $form.find('input[type=submit]').hide().after('<span class="spinner login-submit"/>');
    }
    if (jid) {
      resource = Strophe.getResourceFromJid(jid);
      if (!resource) {
        jid = jid.toLowerCase() + '/converse.js-' + Math.floor(Math.random()*139749825).toString();
      } else {
        jid = Strophe.getBareJidFromJid(jid).toLowerCase()+'/'+Strophe.getResourceFromJid(jid);
      }
    }
    converse.connection.connect(jid, password, converse.onConnectStatusChanged);
  },

  remove: function () {
    this.$tabs.empty();
    this.$el.parent().empty();
  }
});

this.ControlBoxToggle = Backbone.View.extend({
  tagName: 'a',
  className: 'toggle-controlbox',
  id: 'toggle-controlbox',
  events: {
    'click': 'onClick'
  },
  attributes: {
    'href': "#"
  },

  initialize: function () {
    this.render();
  },

  render: function () {
    $('#conversejs').prepend(this.$el.html(
      converse.templates.controlbox_toggle({
        'label_toggle': __('Toggle chat')
      })
    ));
    // We let the render method of ControlBoxView decide whether
    // the ControlBox or the Toggle must be shown. This prevents
    // artifacts (i.e. on page load the toggle is shown only to then
    // seconds later be hidden in favor of the control box).
    this.$el.hide();
    return this;
  },

  hide: function (callback) {
    this.$el.fadeOut('fast', callback);
  },

  show: function (callback) {
    this.$el.show('fast', callback);
  },

  showControlBox: function () {
    var controlbox = converse.chatboxes.get('controlbox');
    if (!controlbox) {
      controlbox = converse.addControlBox();
    }
    if (converse.connection.connected) {
      controlbox.save({closed: false});
    } else {
      controlbox.trigger('show');
    }
  },

  onClick: function (e) {
    e.preventDefault();
    if ($("div#controlbox").is(':visible')) {
      var controlbox = converse.chatboxes.get('controlbox');
      if (converse.connection.connected) {
        controlbox.save({closed: true});
      } else {
        controlbox.trigger('hide');
      }
    } else {
      this.showControlBox();
    }
  }
});
