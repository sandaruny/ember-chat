import Ember from 'ember';
import tawasul2 from 'converse-api/tawasul2';

export default Ember.Component.extend({





  actions: {
    createMessage(message ) {
      //alert(converse);
      tawasul2.myfunc();
      alert('componant '+message);

      this.sendAction('createMessage', message);
      this.set('message', {});
    }
  }
});
