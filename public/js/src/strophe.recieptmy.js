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
  //alert('load plugind');

  Strophe.addConnectionPlugin('receipts', {
      _conn: null,
      _msgQueue: {},
      _retries: {},
      _unseen: {},
      _resendCount: 10,
      _resendTime: 9000,

      init: function(conn) {
          this._conn = conn;
          Strophe.addNamespace('RECEIPTS', 'urn:xmpp:receipts');
          // alert('receipt');
      },


      statusChanged: function (status) {
  		if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
  			// set up handlers for receipts
  			//this._conn.addHandler(this._onRequestReceived.bind(this), Strophe.NS.RECEIPTS, "message");
  			var that = this;
  			setTimeout(function(){that.resendQueue();},5000);
  		}
  	},

  	/*
  	_onRequestReceived: function(msg){
  		this._processReceipt(msg);
  		return true;
  	},
  	* */

      /* sendMessage
      ** sends a message with a receipt and stores the message in the queue
      ** in case a receipt is never received
      **
      ** msg should be a builder
      */
      sendMessage: function(msg) {
          // var id = this._conn.getUniqueId();
          //
          // msg.tree().setAttribute('id', id);
          //
          // var request = Strophe.xmlElement('request', {'xmlns': Strophe.NS.RECEIPTS});
          // msg.tree().appendChild(request);
          //
          // this._msgQueue[id] = msg;
          // this._retries[id] = 0;
          // // this._conn.send(msg);
          //
          // // converse.connection.send(message);
          // this._conn.send(msg);
          // alert('came to plugin to send the mesg \n\n' + msg);
          // msg.c('request', {'xmlns': Strophe.NS.RECEIPTS}).up();
          var request = Strophe.xmlElement('markable', {'xmlns': Strophe.NS.CHATMARKER});
          msg.tree().appendChild(request);

          // var id = $(msg).attr('message').val();

          var timestamp = (new Date()).getTime();
          var id = timestamp;//this._conn.getUniqueId();
          msg.tree().setAttribute('id', timestamp);
          // alert('id and message'+id+ ' \n\n'+msg);


          this._msgQueue[id] = msg;
          // alert('ffffffffffffff'+this._msgQueue[id]);
          this._retries[id] = 0;

          this._conn.send(msg);

          // alert('send msg by stroph');
          // this.resendMessage(id);

          // return id;

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
      addReceiptHandler: function(handler, type, from, options) {
          var that = this;
          // alert('reception hndler');
          var proxyHandler = function(msg) {
              that._processReceipt(msg);

              // call original handler
              return handler(msg);
          };

          this._conn.addHandler(proxyHandler, Strophe.NS.RECEIPTS, 'message',
                                type, null, from, options);
      },

      /*
  	 * process a XEP-0184 message receipts
  	 * send recept on request
  	 * remove msg from queue on received
  	*/
  	_processReceipt: function($mesg){
        // alert('process recpt\n\n ' + $mesg.html());
  		  var id = $mesg.attr('id'),
  			from = $mesg.attr('from'),
  			req = $mesg.find('markable'),
  			rec = $mesg.find('received');
        // alert('vals ok id:'+id+' from:'+from+' rec:'+rec+ ' len:'+ rec.length);

  			// check for request in message
        if (req.length > 0) {

          // alert('got a markable new message, sending delevery');
          // Normal unencrypted message.

        //  sendMessage('sss');
        //  $message.children('body').text('sss') //= 'Recieved By';
          text = '';

        //  this.converse.receipts._processReceipt($message);
          var timestamp = (new Date()).getTime();
          // //  alert(0);
          var bare_jid =  Strophe.getBareJidFromJid($mesg.attr('from'));//this.model.get('jid');
           //var id = $message.attr('id');////////////
        //   alert(bare_jid);
          var recid = $mesg.attr('id');

          // alert(recid+' he');

           var message = $msg({
             from: this._conn.jid,
             to: bare_jid,
             type: 'chat',
            id:  this._conn.getUniqueId()
           })

          .c('body').t(text).up()
          .c('acive', {'xmlns': Strophe.NS.CHATSTATES}).up()
          .c('received', {'xmlns': Strophe.NS.CHATMARKER, 'id':recid }).up();
          this._unseen[id] = $mesg;
          // alert(message);
          this._conn.send(message);
          // alert('sent the delevery receipt');
        //   alert('sending recpt')
  			// 	// send receipt
        //
        //   // //  alert(0);
        //
        //    var bare_jid =  Strophe.getBareJidFromJid(from);//this.model.get('jid');
        // //   alert(bare_jid);
        //    var message = $msg({
        //      from: this._conn.jid,
        //      to: from,
        //      id:  this._conn.getUniqueId()
        //    })
        //
        //   //    .c('body').t('deleverd').up()
        // //      .c('active', {'xmlns': Strophe.NS.CHATSTATES}).up()
        //     .c('received', {'xmlns': Strophe.NS.CHATMARKER, 'id': id}).up();
            // alert(message);
            // this._conn.send(message);
            // alert('sent recpt');

  				// var out = $msg({to: from, from: this._conn.jid, id: this._conn.getUniqueId()}),
  				// request = Strophe.xmlElement('received', {'xmlns': Strophe.NS.RECEIPTS, 'id': id});
  				// out.tree().appendChild(request);


  			}
  			// check for received
        if (rec.length > 0) {
          // alert('!!!!!!!!!!!!!!!!!!!!!!!!!!RECIEVE'+rec.attr('id'));
          var recv_id = rec.attr('id');
  				if (recv_id) { // delete msg from queue
  					// delete this._msgQueue[recv_id];
  					// delete this._retries[recv_id];
            // alert();
          }
        }
  	},


    sendSeen: function(){

      var size = Object.keys(this._msgQueue).length//Object.size(this._unseen);
      // alert('send unseen '+size);
      for (prop in this._unseen) {
          // alert();
          if (!this._unseen.hasOwnProperty(prop)) {
              //The current property is not a direct property of p
              continue;
          }
          // displayed
          // alert(prop + " -> " +this._unseen[prop]);
          text = '';

        //  this.converse.receipts._processReceipt($message);
          var timestamp = (new Date()).getTime();
          $mesg = this._unseen[prop];

        //   var bare_jid =  Strophe.getBareJidFromJid(mesg.tree().getAttribute('from'));//this.model.get('jid');
        //    //var id = $message.attr('id');////////////
        // //   alert(bare_jid);
        //   var recid = mesg.tree().getAttribute('id');

        var bare_jid =  Strophe.getBareJidFromJid($mesg.attr('from'));//this.model.get('jid');
         //var id = $message.attr('id');////////////
      //   alert(bare_jid);
        var recid = $mesg.attr('id');

          // alert(recid+' sending displayed message '+ bare_jid);

           var message = $msg({
             from: this._conn.jid,
             to: bare_jid,
             type: 'chat',
             id:  this._conn.getUniqueId()
           })

          .c('body').t(text).up()
          .c('acive', {'xmlns': Strophe.NS.CHATSTATES}).up()
          .c('displayed', {'xmlns': Strophe.NS.CHATMARKER, 'id':recid }).up();

          // alert(message);
          this._conn.send(message);
          // alert('sent the displayed receipt');

          delete this._unseen[prop];



      }

      // Object.keys(this._unseen).forEach(function(key) {
      //         alert(key);
      // });

      // $.each(this._unseen, function(key, value) {
      //     alert(key+' '+value);
      // });

      // alert('finished');

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
      }
  });




}));
