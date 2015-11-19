import DS from 'ember-data';

export default DS.Model.extend({
  mid: DS.attr('number'),
  msgid: DS.attr('string'),
  body: DS.attr('string'),
  host: DS.attr('string')
});
