<?php
/**
 * Plugin Name: SDR Lab Assistant
 * Description: Adds the SDR FAQ assistant, with a secure link to LabTrax account support.
 * Version: 0.1.0
 * Author: SDR Dental Laboratory
 */
if (!defined('ABSPATH')) { exit; }

add_action('wp_enqueue_scripts', function () {
    wp_enqueue_script(
        'sdr-lab-assistant',
        'https://lab-trax.replit.app/api/support-assistant/widget.js',
        array(),
        '0.1.0',
        true
    );
});
