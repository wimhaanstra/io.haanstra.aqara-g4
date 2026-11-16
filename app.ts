import Homey from 'homey';

class AqaraG4App extends Homey.App {
    async onInit() {
        // Homey proxies URL videos through its own go2rtc only on newer versions with this feature.
        const homey = this.homey as any;
        const streaming = typeof homey.hasFeature === 'function' ? homey.hasFeature('camera-streaming') : 'unknown';
        this.log(`Aqara G4 Doorbell app started on Homey ${this.homey.version} (${this.homey.platform}), camera-streaming feature: ${streaming}`);
    }
}

module.exports = AqaraG4App;
