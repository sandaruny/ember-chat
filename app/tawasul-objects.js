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
  debug:true
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
    if (this.connection && this.connection.connected) {
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
  }
});


