import Ember from 'ember';
import tawasul2 from 'converse-api/tawasul2';


export default Ember.Component.extend({
  actions: {
    logIn(info){
      //alert(info);
      var resource, jid = info.host;
      if (jid) {
        resource = Strophe.getResourceFromJid(jid);
        if (!resource) {
          jid = jid.toLowerCase() + '/converse.js-' + Math.floor(Math.random()*139749825).toString();
        } else {
          jid = Strophe.getBareJidFromJid(jid).toLowerCase()+'/'+Strophe.getResourceFromJid(jid);
        }
      }

      //alert(jid +'  '+ info.pw);
      info.jid = jid;
      this.sendAction('logIn', info);
      this.set('log-user', {});
    }
  }
});
