import { Module } from '@nestjs/common';
import { MempoolModule } from '../mempool/mempool.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { WatcherService } from './watcher.service.js';

@Module({
  imports: [MempoolModule, StorageModule],
  providers: [WatcherService],
  exports: [WatcherService],
})
export class WatcherModule {}
