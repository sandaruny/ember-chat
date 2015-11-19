import { moduleForModel, test } from 'ember-qunit';

moduleForModel('minimized-chat-toggle', 'Unit | Model | minimized chat toggle', {
  // Specify the other units that are required for this test.
  needs: []
});

test('it exists', function(assert) {
  var model = this.subject();
  // var store = this.store();
  assert.ok(!!model);
});
