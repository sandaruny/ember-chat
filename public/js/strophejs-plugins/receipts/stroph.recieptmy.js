/*
* Based on Ping Strophejs plugins (https://github.com/metajack/strophejs-plugins/tree/master/ping)
* This plugin is distributed under the terms of the MIT licence.
* Please see the LICENCE file for details.
*
* Copyright (c) Markus Kohlhase, 2010
* Refactored by Pavel Lang, 2011
*/
/**
* File: strophe.ping.js
* A Strophe plugin for XMPP Ping ( http://xmpp.org/extensions/xep-0199.html )
*/
/*
* AMD Support added by Thierry
*
*/

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define([
            "strophe"
        ], function (Strophe) {
            factory(
                Strophe.Strophe,
                Strophe.$build,
                Strophe.$iq ,
                Strophe.$msg,
                Strophe.$pres
            );
            return Strophe;
        });
    } else {
        // Browser globals
        factory(
            root.Strophe,
            root.$build,
            root.$iq ,
            root.$msg,
            root.$pres
        );
    }
}(this, function (Strophe, $build, $iq, $msg, $pres) {


    Strophe.addConnectionPlugin('receipts', {
        _conn: null,
        _msgQueue: {},
        _retries: {},
        _resendCount: 10,
        _resendTime: 9000,

        init: function(conn) {
            this._conn = conn;
            Strophe.addNamespace('RECEIPTS', 'urn:xmpp:receipts');
            alert('int');
        },


        statusChanged: function (status) {

      		if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
      			// set up handlers for receipts
      			//this._conn.addHandler(this._onRequestReceived.bind(this), Strophe.NS.RECEIPTS, "message");
      			var that = this;
      			setTimeout(function(){that.resendQueue();},5000);

      		}
        //  alert('status ok');
      	},


    	_onRequestReceived: function(msg){
    		this._processReceipt(msg);
    		return true;
    	},


        /* sendMessage
        ** sends a message with a receipt and stores the message in the queue
        ** in case a receipt is never received
        **
        ** msg should be a builder
        */
        sendMessage: function(msg) {
          alert('send msg by stroph\n'+getUnreceivedMsgs());
            var id = this._conn.getUniqueId();
            msg.tree().setAttribute('id', id);

            var request = Strophe.xmlElement('request', {'xmlns': Strophe.NS.RECEIPTS});
            msg.tree().appendChild(request);

            this._msgQueue[id] = msg;
            this._retries[id] = 0;
            // this._conn.send(msg);
            // converse.connection.send(message);
            this._conn.send(msg);
            this.resendMessage(id);

            return id;

        },

        /*
        ** resend queued message
        */
        resendMessage: function(id){
      		var that = this;
      		setTimeout(function(){
      			if (that._msgQueue[id]){
      				// if we are disconnected, dont increment retries count and retry later
      				if (!that._conn.connected) {
      					that.resendMessage(id);
      					return;
      				}
      				that._retries[id]++;
      				if (that._retries[id] > that._resendCount) {
      					//TODO: use mod_rest to force injection of the message
      					console.debug('message could not be delivered after ' + that._resendCount + ' attempts');
      					return;
      				}

      				// FIX: use our actual jid in case we disconnected and changed jid
      				that._msgQueue[id].tree().setAttribute('from', that._conn.jid);

      				that._conn.send(that._msgQueue[id]);
      				that.resendMessage(id);
      			}
      		},this._resendTime);
      	},

    	/* addMessageHandler
        ** add a message handler that handles XEP-0184 message receipts
        */

        // addHiHandler: function(handler)
        // {
        //   alert('hi handler');
        //         // return this._c.addHandler(handler, Strophe.NS.PING, "iq", "get");
        // },


        /*
    	 * process a XEP-0184 message receipts
    	 * send recept on request
    	 * remove msg from queue on received
    	*/
    	_processReceipt: function(msg){
        alert('proccess receiept');
    		var id = msg.getAttribute('id'),
    			from = msg.getAttribute('from'),
    			req = msg.getElementsByTagName('request'),
    			rec = msg.getElementsByTagName('received');
          alert();

    			// check for request in message
                if (req.length > 0) {
    				// send receipt
    				var out = $msg({to: from, from: this._conn.jid, id: this._conn.getUniqueId()}),
    					request = Strophe.xmlElement('received', {'xmlns': Strophe.NS.RECEIPTS, 'id': id});
    				out.tree().appendChild(request);
    				this._conn.send(out);
    			}
    			// check for received
                if (rec.length > 0) {
                    var recv_id = rec[0].getAttribute('id');
    				if (recv_id) { // delete msg from queue
    					delete this._msgQueue[recv_id];
    					delete this._retries[recv_id];
    				}
                }
    	},

    	resendQueue: function(){
    		if (!this._conn.connected) {
    			var that = this;
    			setTimeout(function(){that.resendQueue();},5000);
    			return;
    		}
    		for (var id in this._msgQueue) {
    			if (this._msgQueue.hasOwnProperty(id)) {
    			   this._conn.send(this._msgQueue[id]);
    			}
    		}
    	},

        getUnreceivedMsgs: function() {
            var msgs = [];
            for (var id in this._msgQueue) {
                if (this._msgQueue.hasOwnProperty(id)) {
                    msgs.push(this._msgQueue[id]);
                }
            }
            return msgs;
        },

        clearMessages: function() {
            this._msgQueue = {};
        },

        addReceiptHandler: function(handler , type, from, options) {

            var that = this;

            var proxyHandler = function(msg) {
                that._processReceipt(msg);

                // call original handler
                return handler(msg);
            };
            this._conn.addHandler(proxyHandler, Strophe.NS.RECEIPTS, 'message', type, null, from, options);
            alert('reception hndler');
        }
        // addReceiptHandler: function(handler , type, from, options) {
        //     alert('reception hndler');
        //     var that = this;
        //
        //     var proxyHandler = function(msg) {
        //         that._processReceipt(msg);
        //
        //         // call original handler
        //         return handler(msg);
        //     };
        //
        //     this._conn.addHandler(proxyHandler, Strophe.NS.RECEIPTS, 'message', type, null, from, options);
        // }

    });



}));
