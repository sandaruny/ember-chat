import Ember from 'ember';
import TG from 'converse-api/tawasul-global';

var __ = utils.__.bind(this);
var ___ = utils.___;

var PREBIND = "prebind";


export var ChatSettings = Ember.Object.extend({
  websocket_url:undefined,
  bosh_service_url: undefined,//'http://openfire.mfsnet.io:7070/http-bind/ ',// Please use this connection manager only for testing purposes
  keepalive: true,
  message_carbons: true,
  play_sounds: true,
  roster_groups: true,
  show_controlbox_by_default: true,
  xhr_user_search: false,
  debug: true,
  reconnect: true
});

export var Connection = Ember.Object.extend({
  /**
   * Contains rules to implement the connection
   */
  settings: undefined,
  connection: undefined,

  init: function(){
    this.initConnection();
  },

  initConnection: function(){

    console.log('Init Connection');

    if (this.connection && this.connection.connected) {
      console.log('Init Connection: connected state');
      //this.setUpXMLLogging();
      //this.onConnected();
    } else {
      if (!this.settings.bosh_service_url && ! this.settings.websocket_url) {
        throw new Error("initConnection: you must supply a value for either the bosh_service_url or websocket_url or both.");
      }
      if (('WebSocket' in window || 'MozWebSocket' in window) && this.settings.websocket_url) {
        this.connection = new Strophe.Connection(this.settings.websocket_url);
      } else if (this.settings.bosh_service_url) {
        this.connection = new Strophe.Connection(this.settings.bosh_service_url, {'keepalive': this.settings.keepalive});
        console.log('Init Connection: created connecttion');

      } else {
        throw new Error("initConnection: this browser does not support websockets and bosh_service_url wasn't specified.");
      }
      //this.setUpXMLLogging();

      // We now try to resume or automatically set up a new session.
      // Otherwise the user will be shown a login form.
      if (this.settings.authentication === TG.PREBIND) {
        //this.attemptPreboundSession();
      } else {
        //this.attemptNonPreboundSession();
      }
    }
  },
  connect: function(jid, pw, handler){
    this.connection.connect(jid, pw, handler);
  }
});



/**
 * This will sync with the roster in th localstorage and the
 * loaded one from the server
 */
var Roster = Ember.Object.extend({

  _rosterList: {},
  /**
   * Roster DS Structure
   */
  _rosterContacts: undefined,






});

/**
 * This class is responsible as the main agent that creates
 * and updates the chat interface in the main stream
 *
 */
export var EmberChatManager = Ember.Object.extend({

  /**
   * Stores the Connection Variable with the custom settings
   */
  connection:undefined,
  disconnectionCause: undefined,
  _connectionHandlers:[],
  _reconnectionHandlers:[],
  _rosterManager: undefined,

  init: function(){
    this._rosterManager = Roster.create();
  },

  /**
   * Initialize the connection with the handler of the ChatManager
   *
   * @param jid JID of the connecting user
   * @param password Password of the connecting user
   */
  initConnection: function(jid, password){
    console.log('INIT Connection');
    var that = this;
    this.connection.connect(jid, password, function(status, condition, reconnect){
      that.onConnectStatusChanged(status, condition, reconnect);
    });

  },

  onConnected : function(){
    console.log('status changed on connect');

    var timestamp = (new Date()).getTime();
    var iq = $iq({type: 'get', 'id': timestamp})
      .c('query', {xmlns: Strophe.NS.ROSTER});
    this.connection.connection.sendIQ(iq, function(iq){alert('received '+$(iq).html());});

    console.log('sent IQ');

    var i;
    for	(i= 0; i< this._connectionHandlers.length; i++) {
      this._connectionHandlers[i]();
    }

  },
  /**
   * Status Change in the Connection
   *
   * This is called when the status is changed
   *
   * @param status Strophe.Status
   * @param condition
   * @param reconnect
   */
  onConnectStatusChanged: function (status, condition, reconnect) {

    //console.log("Status changed to: "+PRETTY_CONNECTION_STATUS[status]);
    if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
       this.disconnectionCause = undefined;
      if ((typeof reconnect !== 'undefined') && (connection.settings.reconnect)) {
        console.log(status === Strophe.Status.CONNECTED ? 'Reconnected' : 'Reattached');
        this.onReconnected();
      } else {
        console.log(status === Strophe.Status.CONNECTED ? 'Connected' : 'Attached');
        this.onConnected();
      }
    } else if (status === Strophe.Status.DISCONNECTED) {
      if (this.disconnectionCause=== Strophe.Status.CONNFAIL && connection.auto_reconnect) {
        reconnect(condition);
      } else {

        //:TODO: show the login panel and delete the session
        //converse.renderLoginPanel();
      }
    } else if (status === Strophe.Status.ERROR) {
      console.log('ERROR');
      //giveFeedback(__('Error'), 'error');
    } else if (status === Strophe.Status.CONNECTING) {
      console.log('CONNECTING');
      //giveFeedback(__('Connecting'));
    } else if (status === Strophe.Status.AUTHENTICATING) {
      console.log('AUTHENTICATING');
      //giveFeedback(__('Authenticating'));
    } else if (status === Strophe.Status.AUTHFAIL) {
      console.log('AUTHFAIL');
      //giveFeedback(__('Authentication Failed'), 'error');
      //connection.disconnect(__('Authentication Failed'));
      this.disconnectionCause = Strophe.Status.AUTHFAIL;
    } else if (status === Strophe.Status.CONNFAIL) {
      this.disconnectionCause = Strophe.Status.CONNFAIL;
      console.log('CONNFAIL');
    } else if (status === Strophe.Status.DISCONNECTING) {
      // FIXME: what about prebind?
      // TODO: connection connected UI View Trigger
      if (!connection.connected) {
        //converse.renderLoginPanel();
      }
      if (condition) {
        //giveFeedback(condition, 'error');
      }
    }
    console.log('status changed: '+status+ ' ' + Strophe.Status.CONNECTED);
  },



  onReconnected: function(){
    console.log('status changed on reconnect');
    var i;
    for	(i= 0; i< this._reconnectionHandlers.length; i++) {
      this._reconnectionHandlers[i]();
    }
  },

  addHandler: function(handler, namespace){
    console.log('Add Handler: '+ namespace);
    switch (namespace){
       case TG.CONNECT:
         this._connectionHandlers.push(handler);
         break;
       case TG.RECONNECT:
         this._reconnectionHandlers.push(handler);
         break;
    }
  }





});

/**
 * ChatAPI to communicate the Manager
 */
export var ChatAPI = Ember.Object.extend({

  /**
   * Stores the manager Variable with the custom settings
   */
  chatManager:undefined,


  initConnection: function(jid, password){
      this.chatManager.initConnection(jid, password);
  },
  /**
   * Add the handler to call back the function of the componants
   *
   * @param handler
   * @param namespace
   */
  addHandler: function(handler, namespace){
    this.chatManager.addHandler(handler, namespace);
  }






});
