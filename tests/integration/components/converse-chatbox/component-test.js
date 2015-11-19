import { moduleForComponent, test } from 'ember-qunit';
import hbs from 'htmlbars-inline-precompile';

moduleForComponent('converse-chatbox', 'Integration | Component | converse chatbox', {
  integration: true
});

test('it renders', function(assert) {
  assert.expect(2);

  // Set any properties with this.set('myProperty', 'value');
  // Handle any actions with this.on('myAction', function(val) { ... });

  this.render(hbs`{{converse-chatbox}}`);

  assert.equal(this.$().text().trim(), '');

  // Template block usage:
  this.render(hbs`
    {{#converse-chatbox}}
      template block text
    {{/converse-chatbox}}
  `);

  assert.equal(this.$().text().trim(), 'template block text');
});
