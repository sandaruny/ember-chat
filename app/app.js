import Ember from 'ember';
import Resolver from 'ember/resolver';
import loadInitializers from 'ember/load-initializers';
import DS from 'ember-data';
import config from './config/environment';

var App;

Ember.MODEL_FACTORY_INJECTIONS = true;

//App  = Ember.Application.create();


App = Ember.Application.extend({
  modulePrefix: config.modulePrefix,
  podModulePrefix: config.podModulePrefix,
  Resolver: Resolver
});

  loadInitializers(App, config.modulePrefix);

export default App;


App.OTR = DS.Model.extend({
  // A model for managing OTR settings.
  getSessionPassphrase: function () {
    if (converse.authentication === 'prebind') {
      var key = b64_sha1(converse.connection.jid),
        pass = window.sessionStorage[key];
      if (typeof pass === 'undefined') {
        pass = Math.floor(Math.random() * 4294967295).toString();
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
        window.sessionStorage[b64_sha1(jid + 'priv_key')] =
          cipher.encrypt(CryptoJS.algo.AES, key.packPrivate(), pass).toString();
        window.sessionStorage[b64_sha1(jid + 'instance_tag')] = instance_tag;
        window.sessionStorage[b64_sha1(jid + 'pass_check')] =
          cipher.encrypt(CryptoJS.algo.AES, 'match', pass).toString();
      }
    }
    return key;
  }
});

App.ChatBox = DS.Model.extend({

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

App.ChatRoomOccupant = DS.Model;

App.ChatRoomOccupants = DS.Model.extend({
  chatRoomOccupants :  DS.hasMany('ChatRoomOccupant')
});

App.ChatBoxes = DS.Model.extend({
  chatBoxes: DS.hasMany('ChatBox'),
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

App.MinimizedChatsToggle = DS.Model.extend({
  initialize: function () {
    this.set({
      'collapsed': this.get('collapsed') || false,
      'num_minimized': this.get('num_minimized') || 0,
      'num_unread':  this.get('num_unread') || 0
    });
  }
});

App.RosterContact = DS.Model.extend({
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
      'image': "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",
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

App.RosterContacts = DS.Model.extend({
  rosterContacts: DS.hasMany('RosterContact'),
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

App.RosterGroups = DS.Model.extend({
  rosterGroups: DS.hasMany('RosterGroup'),
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

App.XMPPStatus = DS.Model.extend({
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

App.Session = Ember.Object.extend({



}); // General session settings to be saved to sessionStorage.
App.Feature = DS.Model;
App.Features = DS.Model.extend({
  /* Service Discovery
   * -----------------
   * This collection stores Feature Models, representing features
   * provided by available XMPP entities (e.g. servers)
   * See XEP-0030 for more details: http://xmpp.org/extensions/xep-0030.html
   * All features are shown here: http://xmpp.org/registrar/disco-features.html
   */
  features: DS.hasMany('Feature'),
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
