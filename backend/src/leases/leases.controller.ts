import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AuthedRequest } from '../common/auth-user';
import { CreateLeaseDto, TerminateLeaseDto } from './leases.dto';
import { LeasesService } from './leases.service';

@Controller('leases')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeasesController {
  constructor(private readonly leases: LeasesService) {}

  @Post()
  @Roles('PROPRIETAIRE')
  create(@Req() req: AuthedRequest, @Body() dto: CreateLeaseDto) {
    return this.leases.create(req.user, dto);
  }

  // Bailleur : ses baux ; locataire : ses baux
  @Get()
  list(@Req() req: AuthedRequest) {
    return this.leases.list(req.user);
  }

  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.leases.get(req.user, id);
  }

  @Get(':id/debt')
  debt(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.leases.debt(req.user, id);
  }

  @Post(':id/terminate')
  @Roles('PROPRIETAIRE')
  @HttpCode(200)
  terminate(@Req() req: AuthedRequest, @Param('id', ParseIntPipe) id: number, @Body() dto: TerminateLeaseDto) {
    return this.leases.terminate(req.user, id, dto);
  }
}
